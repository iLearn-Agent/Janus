#!/bin/sh
set -eu
root_password="$(cat "$MINIO_ROOT_PASSWORD_FILE")"
api_secret="$(cat "$JANUS_MINIO_API_SECRET_KEY_FILE")"
worker_secret="$(cat "$JANUS_MINIO_WORKER_SECRET_KEY_FILE")"
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$root_password"
mc mb --ignore-existing "local/$JANUS_S3_BUCKET"
cat > /tmp/janus-bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::$JANUS_S3_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$JANUS_S3_BUCKET/*"]
    }
  ]
}
EOF
mc admin policy create local janus-bucket-rw /tmp/janus-bucket-policy.json || true
mc admin user add local "$JANUS_MINIO_API_ACCESS_KEY" "$api_secret" || true
mc admin user add local "$JANUS_MINIO_WORKER_ACCESS_KEY" "$worker_secret" || true
mc admin policy attach local janus-bucket-rw --user "$JANUS_MINIO_API_ACCESS_KEY"
mc admin policy attach local janus-bucket-rw --user "$JANUS_MINIO_WORKER_ACCESS_KEY"
