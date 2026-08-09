CREATE TABLE IF NOT EXISTS janus_database_identity (
  id text PRIMARY KEY CHECK (id='primary'),
  product_namespace text NOT NULL CHECK (product_namespace='janus'),
  data_generation integer NOT NULL CHECK (data_generation=1),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO janus_database_identity(id,product_namespace,data_generation)
VALUES('primary','janus',1)
ON CONFLICT(id) DO UPDATE SET
  product_namespace=excluded.product_namespace,
  data_generation=excluded.data_generation;
