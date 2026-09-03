select count(*) as table_count
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE';

  select id, role, display_name
  from users
  order by id;

  select user_id, family_id
  from user_pairs;