-- بيت الورد — ترقية السيرفر: النواقص تتزامن + تدوين "مين عمل إيه" على كل عملية
-- شغّله مرة واحدة في Supabase → SQL Editor. آمن لو اتشغّل أكتر من مرة.

begin;

-- 1) أعمدة جديدة: الكمية (للنواقص) + اسم اللي عمل العملية
alter table public.ledger_ops add column if not exists qty   text;
alter table public.ledger_ops add column if not exists actor text;
alter table public.ledger_ops alter column customer_id drop not null;  -- عمليات النواقص مالهاش عميل

alter table public.ledger_ops drop constraint if exists ledger_ops_qty_check;
alter table public.ledger_ops add  constraint ledger_ops_qty_check   check (qty   is null or char_length(qty)   <= 80);
alter table public.ledger_ops drop constraint if exists ledger_ops_actor_check;
alter table public.ledger_ops add  constraint ledger_ops_actor_check check (actor is null or char_length(actor) <= 60);

-- 2) أنواع العمليات الجديدة (النواقص)
alter table public.ledger_ops drop constraint if exists ledger_ops_type_check;
alter table public.ledger_ops add  constraint ledger_ops_type_check check (type = any (array[
  'customer_create','customer_update','customer_archive','debt','payment','tx_amend','tx_void','review_ack',
  'need_add','need_update','need_done','need_delete']));

alter table public.ledger_ops drop constraint if exists ledger_ops_shape;
alter table public.ledger_ops add  constraint ledger_ops_shape check (
case type
  when 'customer_create'  then customer_id is not null and name is not null and btrim(name) <> ''
  when 'customer_update'  then customer_id is not null and name is not null and btrim(name) <> ''
  when 'customer_archive' then customer_id is not null and flag is not null
  when 'debt'             then customer_id is not null and amount is not null and op_date is not null
  when 'payment'          then customer_id is not null and amount is not null and op_date is not null
  when 'tx_amend'         then customer_id is not null and amount is not null and op_date is not null and target_id is not null
  when 'tx_void'          then customer_id is not null and target_id is not null
  when 'review_ack'       then customer_id is not null and target_id is not null
  when 'need_add'         then target_id is not null and name is not null and btrim(name) <> ''
  when 'need_update'      then target_id is not null and name is not null and btrim(name) <> ''
  when 'need_done'        then target_id is not null and flag is not null
  when 'need_delete'      then target_id is not null
  else false
end);

-- 3) العمليات القديمة: خُد اسم المسجِّل من اسم الجهاز المسجّل
update public.ledger_ops o
   set actor = left(btrim(d.name), 60)
  from public.devices d
 where d.device_id = o.device_id and o.actor is null and btrim(d.name) <> '';

-- 4) push_ops: يقبل qty و actor (لو الموبايل ماجابش اسم، يُستخدم اسم الجهاز المسجّل)
create or replace function public.push_ops(p_code text, p_device_id uuid, p_ops jsonb)
 returns jsonb language plpgsql security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  o jsonb; ex public.ledger_ops; v_id uuid;
  acked uuid[] := '{}'; errs jsonb := '[]'::jsonb; v_dev text;
begin
  perform public._check_code(p_code);
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then raise exception 'bad_payload'; end if;
  if jsonb_array_length(p_ops) > 200 then raise exception 'too_many_ops'; end if;
  select nullif(btrim(name), '') into v_dev from public.devices where device_id = p_device_id;

  for o in select value from jsonb_array_elements(p_ops) loop
    begin
      v_id := (o->>'id')::uuid;
      insert into public.ledger_ops(id, type, customer_id, target_id, base_id, amount, op_date, note, name, phone, flag, qty, actor, device_id, client_created_at)
      values (v_id, o->>'type', nullif(o->>'customer_id','')::uuid,
              nullif(o->>'target_id','')::uuid, nullif(o->>'base_id','')::uuid,
              nullif(o->>'amount','')::numeric, nullif(o->>'op_date','')::date,
              o->>'note', o->>'name', o->>'phone', nullif(o->>'flag','')::boolean,
              nullif(o->>'qty',''),
              coalesce(nullif(btrim(left(o->>'actor', 60)), ''), v_dev),
              coalesce(nullif(o->>'device_id','')::uuid, p_device_id),
              (o->>'client_created_at')::timestamptz)
      on conflict (id) do nothing;

      select * into ex from public.ledger_ops where id = v_id;
      if ex.type is distinct from (o->>'type')
         or ex.customer_id is distinct from nullif(o->>'customer_id','')::uuid
         or ex.amount is distinct from round(nullif(o->>'amount','')::numeric, 2)
         or ex.op_date is distinct from nullif(o->>'op_date','')::date
         or ex.target_id is distinct from nullif(o->>'target_id','')::uuid then
        errs := errs || jsonb_build_object('id', v_id, 'msg', 'id_conflict');
      else
        acked := acked || v_id;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('id', o->>'id', 'msg', sqlerrm);
    end;
  end loop;

  update public.devices set last_seen = now() where device_id = p_device_id;
  return jsonb_build_object('acked', to_jsonb(acked), 'errors', errs);
end $function$;

-- 5) pull_ops: يرجّع qty و actor
create or replace function public.pull_ops(p_code text, p_since timestamp with time zone, p_after_seq bigint default 0, p_limit integer default 500)
 returns jsonb language plpgsql security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_lim int := least(greatest(coalesce(p_limit, 500), 1), 1000); v_rows jsonb; v_n int;
begin
  perform public._check_code(p_code);
  with page as (
    select id, type, customer_id, target_id, base_id, amount, op_date, note, name, phone, flag, qty, actor,
           device_id, client_created_at, received_at, seq
    from public.ledger_ops
    where received_at > p_since and seq > coalesce(p_after_seq, 0)
    order by seq limit v_lim + 1
  ), numbered as (
    select to_jsonb(page) j, row_number() over (order by page.seq) rn from page
  )
  select coalesce(jsonb_agg(j order by rn) filter (where rn <= v_lim), '[]'::jsonb), count(*)
    into v_rows, v_n from numbered;
  return jsonb_build_object('rows', v_rows, 'has_more', v_n > v_lim);
end $function$;

-- 6) للقراءة من لوحة Supabase: قائمة النواقص الحالية + سجل النشاط (مين عمل إيه ومتى)
create or replace view public.needs_current with (security_invoker = true) as
with n as (
  select target_id as id,
    (array_agg(name  order by seq desc) filter (where type in ('need_add','need_update')))[1] as name,
    (array_agg(qty   order by seq desc) filter (where type in ('need_add','need_update')))[1] as qty,
    (array_agg(note  order by seq desc) filter (where type in ('need_add','need_update')))[1] as note,
    coalesce((array_agg(flag order by seq desc) filter (where type in ('need_add','need_update')))[1], false) as urgent,
    coalesce((array_agg(flag order by seq desc) filter (where type = 'need_done'))[1], false) as done,
    bool_or(type = 'need_delete') as deleted,
    min(client_created_at) filter (where type = 'need_add') as added_at,
    (array_agg(actor order by seq)      filter (where type = 'need_add'))[1] as added_by,
    (array_agg(actor order by seq desc) filter (where type = 'need_update'))[1] as edited_by,
    (array_agg(actor order by seq desc) filter (where type = 'need_done' and flag))[1] as done_by,
    (array_agg(client_created_at order by seq desc) filter (where type = 'need_done' and flag))[1] as done_at
  from public.ledger_ops
  where type in ('need_add','need_update','need_done','need_delete')
  group by target_id)
select id, name, qty, note, urgent, done, added_at, added_by, edited_by,
       case when done then done_by end as done_by, case when done then done_at end as done_at
from n where not deleted;

create or replace view public.activity_log with (security_invoker = true) as
select o.seq, o.client_created_at as at, o.received_at,
       coalesce(o.actor, d.name) as who, d.name as device_name, o.type,
       case o.type
         when 'customer_create'  then 'إضافة عميل'      when 'customer_update' then 'تعديل بيانات عميل'
         when 'customer_archive' then case when o.flag then 'أرشفة عميل' else 'إلغاء أرشفة' end
         when 'debt' then 'تسجيل دين'  when 'payment' then 'تسجيل دفعة'
         when 'tx_amend' then 'تعديل معاملة' when 'tx_void' then 'إلغاء معاملة' when 'review_ack' then 'مراجعة تعارض'
         when 'need_add' then 'إضافة للنواقص' when 'need_update' then 'تعديل صنف ناقص'
         when 'need_done' then case when o.flag then 'تعليم "اتجاب"' else 'إرجاع للنواقص' end
         when 'need_delete' then 'حذف من النواقص'
       end as action,
       coalesce(cn.name, nn.name, o.name) as subject, o.amount, o.op_date, o.note, o.qty
from public.ledger_ops o
left join public.devices d on d.device_id = o.device_id
left join lateral (select x.name from public.ledger_ops x
                   where x.customer_id = o.customer_id and x.type in ('customer_create','customer_update')
                   order by x.seq desc limit 1) cn on o.customer_id is not null
left join lateral (select x.name from public.ledger_ops x
                   where x.target_id = o.target_id and x.type in ('need_add','need_update')
                   order by x.seq desc limit 1) nn on o.type like 'need\_%'
order by o.seq desc;

revoke all on public.needs_current, public.activity_log from anon, authenticated;

commit;

-- (اختياري) منع تعديل أو حذف أي عملية بعد تسجيلها، عشان سجل "مين عمل إيه" يفضل سليم:
-- create or replace function public._ledger_immutable() returns trigger language plpgsql as
--   $$ begin raise exception 'ledger_ops is append-only'; end $$;
-- create trigger ledger_ops_immutable before update or delete on public.ledger_ops
--   for each row execute function public._ledger_immutable();

-- فحص أمان سريع: المفروض ما يظهرش أي جدول/فيو فيه بيانات للـ anon
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated');
