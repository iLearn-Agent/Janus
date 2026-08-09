import crypto from 'node:crypto';

export async function cloudSchemaFingerprint(pool) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  const entries = [];
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL search_path = ''");
  await collect(entries, client, 'relations', `
    SELECT c.relname AS name,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
           COALESCE(pg_get_partkeydef(c.oid),'') AS partition_key
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
    ORDER BY c.relname`);
  await collect(entries, client, 'columns', `
    SELECT c.relname AS relation,a.attnum,a.attname,
           pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
           a.attnotnull,COALESCE(pg_get_expr(d.adbin,d.adrelid),'') AS default_expression,
           a.attidentity,a.attgenerated,COALESCE(coll.collname,'') AS collation
    FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`);
  await collect(entries, client, 'constraints', `
    SELECT c.relname AS relation,con.conname,con.contype,
           pg_get_constraintdef(con.oid,true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
    ORDER BY c.relname,con.conname`);
  await collect(entries, client, 'indexes', `
    SELECT t.relname AS relation,i.relname AS name,pg_get_indexdef(i.oid) AS definition
    FROM pg_index x
    JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public'
    ORDER BY t.relname,i.relname`);
  await collect(entries, client, 'functions', `
    SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
           pg_get_function_result(p.oid) AS result,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
    ORDER BY p.proname,arguments`);
  await collect(entries, client, 'triggers', `
    SELECT c.relname AS relation,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
    ORDER BY c.relname,t.tgname`);
  await collect(entries, client, 'policies', `
    SELECT c.relname AS relation,p.polname,p.polpermissive,
           ARRAY(SELECT rolname FROM pg_roles WHERE oid=ANY(p.polroles) ORDER BY rolname) AS roles,
           COALESCE(pg_get_expr(p.polqual,p.polrelid),'') AS using_expression,
           COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') AS check_expression
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
    ORDER BY c.relname,p.polname`);
  await collect(entries, client, 'types', `
    SELECT t.typname,t.typtype,COALESCE(array_agg(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL),'{}') AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' AND t.typtype IN ('e','d')
    GROUP BY t.typname,t.typtype ORDER BY t.typname`);
  await collect(entries, client, 'extensions', `SELECT extname FROM pg_extension ORDER BY extname`);
  const canonical = entries.map((entry) => JSON.stringify(entry)).join('\n');
  const result = {
    algorithm: 'sha256',
    fingerprint: crypto.createHash('sha256').update(canonical).digest('hex'),
    objectCount: entries.length,
  };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
}

async function collect(entries, pool, kind, sql) {
  const result = await pool.query(sql);
  for (const row of result.rows) entries.push({ kind, ...normalize(row) });
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
}
