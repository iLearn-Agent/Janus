-- requires-real-postgres: organization friendship backfill uses production PostgreSQL correlation semantics
INSERT INTO friendships (id, user_a_id, user_b_id, status, created_at, updated_at)
SELECT 'friendship_org_' || md5(left_member.user_id || ':' || right_member.user_id),
       left_member.user_id,
       right_member.user_id,
       'accepted',
       now(),
       now()
FROM contact_organization_members left_member
JOIN contact_organization_members right_member
  ON right_member.organization_id = left_member.organization_id
 AND left_member.user_id < right_member.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM user_blocks block
  WHERE (block.blocker_id = left_member.user_id AND block.blocked_id = right_member.user_id)
     OR (block.blocker_id = right_member.user_id AND block.blocked_id = left_member.user_id)
)
ON CONFLICT (user_a_id, user_b_id)
DO UPDATE SET status = 'accepted', updated_at = excluded.updated_at;
