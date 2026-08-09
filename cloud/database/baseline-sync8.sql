-- Janus Community PostgreSQL baseline for Cloud Sync 8.
-- Generated from the schema resulting from historical migrations 001-081.
-- This file is valid only for an empty database.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
  ) THEN RAISE EXCEPTION 'baseline_sync8_081 requires an empty public schema'; END IF;
END $$;

--
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: janus_guard_cluster_evidence_claim_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.janus_guard_cluster_evidence_claim_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.claim_state NOT IN ('reserved','consumed') OR NEW.consumer_id='' OR NEW.run_id='' THEN
    RAISE EXCEPTION 'invalid cluster evidence claim';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.evidence_id<>OLD.evidence_id OR
      (OLD.claim_state='consumed' AND (
        NEW.claim_state<>OLD.claim_state OR NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id
      )) OR
      (OLD.claim_state='reserved' AND NEW.claim_state='reserved' AND (
        NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id
      ))
    THEN
      RAISE EXCEPTION 'invalid cluster evidence claim transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: janus_guard_evolution_evidence_usage_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.janus_guard_evolution_evidence_usage_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.rejection_kind NOT IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown') THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF NEW.status='evaluated_rejected' AND NEW.rejection_kind='' THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF NEW.status<>'evaluated_rejected' AND NEW.rejection_kind<>'' THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.evidence_id<>OLD.evidence_id OR NEW.evolution_scope<>OLD.evolution_scope OR NEW.consumer_id<>OLD.consumer_id THEN
      RAISE EXCEPTION 'invalid evidence usage transition';
    END IF;
    IF NEW.status<>OLD.status AND NOT (
      (OLD.status IN ('available','released') AND NEW.status='reserved') OR
      (OLD.status='reserved' AND NEW.status IN ('consumed','evaluated_rejected','released')) OR
      (OLD.status='evaluated_rejected' AND NEW.status='reserved'
        AND NEW.run_id<>'' AND NEW.run_id<>OLD.run_id
        AND NEW.re_evaluation_basis_hash<>''
        AND NEW.re_evaluation_basis_hash<>OLD.re_evaluation_basis_hash)
    ) THEN
      RAISE EXCEPTION 'invalid evidence usage transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: janus_guard_released_market_section_content(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.janus_guard_released_market_section_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM cloud_market_agent_versions
    WHERE id=COALESCE(OLD.market_version_id,NEW.market_version_id);
  IF parent_status='released' THEN RAISE EXCEPTION 'released market version sections are immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;


--
-- Name: janus_guard_released_market_version_content(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.janus_guard_released_market_version_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status='released' AND (
    NEW.agent_family_id IS DISTINCT FROM OLD.agent_family_id OR
    NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id OR
    NEW.version_kind IS DISTINCT FROM OLD.version_kind OR
    NEW.base_agent_version_id IS DISTINCT FROM OLD.base_agent_version_id OR
    NEW.sections_json IS DISTINCT FROM OLD.sections_json OR
    NEW.health_baseline_json IS DISTINCT FROM OLD.health_baseline_json OR
    NEW.payload_json IS DISTINCT FROM OLD.payload_json
  ) THEN RAISE EXCEPTION 'released market version content is immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: janus_set_cluster_participation_authority(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.janus_set_cluster_participation_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.personal_evolution_consent=(NEW.sync_enabled AND NEW.status='active');
  NEW.cluster_contribution_consent=(NEW.sync_enabled AND NEW.status='active');
  NEW.personal_skill_auto_activate=false;
  RETURN NEW;
END $$;


--
-- Name: sync_account_workspace_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_account_workspace_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_workspace_memberships SET status=CASE
        WHEN EXISTS(SELECT 1 FROM account_workspaces WHERE id='workspace_org_' || OLD.organization_id AND status='inactive')
          THEN 'removed'
        ELSE 'left'
      END,updated_at=now()
      WHERE workspace_id='workspace_org_' || OLD.organization_id AND user_id=OLD.user_id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
  VALUES('workspace_org_' || NEW.organization_id,NEW.user_id,
    CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


--
-- Name: sync_account_workspace_organization(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_account_workspace_organization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_workspaces SET status='inactive',updated_at=now()
      WHERE id='workspace_org_' || OLD.id;
    UPDATE account_workspace_memberships SET status='removed',updated_at=now()
      WHERE workspace_id='workspace_org_' || OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_' || NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


--
-- Name: sync_organization_account_membership_v8(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_organization_account_membership_v8() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_memberships_v8 SET status=CASE
        WHEN EXISTS(SELECT 1 FROM accounts WHERE id='account_org_' || OLD.organization_id AND status='archived') THEN 'removed'
        ELSE 'left'
      END,updated_at=now()
    WHERE account_id='account_org_' || OLD.organization_id AND user_id=OLD.user_id;
    RETURN OLD;
  END IF;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_org_' || NEW.organization_id,NEW.user_id,
    CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


--
-- Name: sync_organization_account_v8(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_organization_account_v8() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE accounts SET status='archived',updated_at=now() WHERE id='account_org_' || OLD.id;
    UPDATE account_memberships_v8 SET status='removed',updated_at=now() WHERE account_id='account_org_' || OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_' || NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_org_' || NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_org_' || NEW.id,'workspace_org_' || NEW.id,'','organization',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


--
-- Name: sync_personal_account_v8(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_personal_account_v8() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_personal_' || NEW.id,'personal',NEW.id,'',COALESCE(NEW.display_name,'个人账号'),'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_personal_' || NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_personal_' || NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


--
-- Name: sync_personal_account_workspace_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_personal_account_workspace_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
  VALUES('workspace_personal',NEW.id,'owner','active',COALESCE(NEW.display_name,''),COALESCE(NEW.avatar_url,''),NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,
    avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_memberships_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_memberships_v8 (
    account_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_memberships_v8_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'guest'::text]))),
    CONSTRAINT account_memberships_v8_status_check CHECK ((status = ANY (ARRAY['active'::text, 'left'::text, 'removed'::text, 'suspended'::text])))
);


--
-- Name: account_workspace_bindings_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_workspace_bindings_v8 (
    account_id text NOT NULL,
    workspace_id text NOT NULL,
    user_id_scope text DEFAULT ''::text NOT NULL,
    binding_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_workspace_bindings_v8_binding_kind_check CHECK ((binding_kind = ANY (ARRAY['personal'::text, 'organization'::text])))
);


--
-- Name: account_workspace_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_workspace_memberships (
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    avatar_url text DEFAULT ''::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_workspace_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'guest'::text]))),
    CONSTRAINT account_workspace_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'left'::text, 'removed'::text, 'suspended'::text])))
);


--
-- Name: account_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_workspaces (
    id text NOT NULL,
    workspace_kind text NOT NULL,
    organization_id text DEFAULT ''::text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    avatar_url text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_workspaces_kind_check CHECK ((workspace_kind = ANY (ARRAY['personal'::text, 'organization'::text]))),
    CONSTRAINT account_workspaces_workspace_kind_check CHECK ((workspace_kind = ANY (ARRAY['personal'::text, 'organization'::text])))
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id text NOT NULL,
    account_kind text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    organization_id text DEFAULT ''::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounts_account_kind_check CHECK ((account_kind = ANY (ARRAY['personal'::text, 'organization'::text]))),
    CONSTRAINT accounts_check CHECK ((((account_kind = 'personal'::text) AND (owner_user_id <> ''::text) AND (organization_id = ''::text)) OR ((account_kind = 'organization'::text) AND (organization_id <> ''::text)))),
    CONSTRAINT accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text, 'external'::text])))
);


--
-- Name: agent_delegation_execution_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegation_execution_leases (
    delegation_id text NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL,
    recipient_user_id text NOT NULL,
    device_id text NOT NULL,
    lease_token text NOT NULL,
    execution_epoch bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    renewed_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    release_reason text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_delegation_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegation_revisions (
    id text NOT NULL,
    delegation_id text NOT NULL,
    author_user_id text NOT NULL,
    revision_no integer DEFAULT 1 NOT NULL,
    action text DEFAULT 'draft'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_delegation_workspace_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegation_workspace_messages (
    id text NOT NULL,
    delegation_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_event_id text DEFAULT ''::text NOT NULL,
    source_group_message_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_delegation_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegation_workspaces (
    delegation_id text NOT NULL,
    user_id text NOT NULL,
    session_id text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_delegations (
    id text NOT NULL,
    requester_user_id text NOT NULL,
    recipient_user_id text NOT NULL,
    sender_agent_id text DEFAULT 'secretary_agent'::text NOT NULL,
    recipient_agent_id text DEFAULT 'secretary_agent'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    instruction text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'assigned'::text NOT NULL,
    session_id text DEFAULT ''::text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    group_id text DEFAULT ''::text NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL,
    client_request_id text DEFAULT ''::text NOT NULL
);


--
-- Name: chat_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_members (
    group_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    invited_by_user_id text DEFAULT ''::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    last_read_at timestamp with time zone,
    display_name_override text DEFAULT ''::text NOT NULL,
    CONSTRAINT chat_group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT chat_group_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'left'::text, 'removed'::text, 'declined'::text])))
);


--
-- Name: chat_group_message_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_message_files (
    id text NOT NULL,
    account_workspace_id text NOT NULL,
    owner_user_id text NOT NULL,
    group_id text NOT NULL,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    sha256 text DEFAULT ''::text NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_group_message_files_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: chat_group_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_messages (
    id text NOT NULL,
    account_workspace_id text NOT NULL,
    group_id text NOT NULL,
    sender_user_id text NOT NULL,
    sender_agent_id text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'friend'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_event_id text DEFAULT ''::text NOT NULL,
    request_payload_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_group_messages_kind_check CHECK ((kind = ANY (ARRAY['friend'::text, 'agent'::text, 'system'::text])))
);


--
-- Name: chat_group_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_group_operations (
    idempotency_key text NOT NULL,
    group_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_kind text NOT NULL,
    request_payload_hash text NOT NULL,
    response_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_group_operations_operation_kind_check CHECK ((operation_kind = 'update_group'::text))
);


--
-- Name: chat_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_groups (
    id text NOT NULL,
    account_workspace_id text NOT NULL,
    organization_id text DEFAULT ''::text NOT NULL,
    owner_user_id text NOT NULL,
    title text DEFAULT '新群聊'::text NOT NULL,
    scope_type text DEFAULT 'external'::text NOT NULL,
    chat_mode text DEFAULT 'conversation'::text NOT NULL,
    binding_type text DEFAULT 'manual'::text NOT NULL,
    binding_id text DEFAULT ''::text NOT NULL,
    history_visibility text DEFAULT 'from_join'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    client_request_id text NOT NULL,
    request_payload_hash text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dissolved_at timestamp with time zone,
    audience_scope text DEFAULT 'account_social'::text NOT NULL,
    CONSTRAINT chat_groups_binding_type_check CHECK ((binding_type = ANY (ARRAY['manual'::text, 'organization'::text, 'department'::text]))),
    CONSTRAINT chat_groups_chat_mode_check CHECK ((chat_mode = ANY (ARRAY['conversation'::text, 'topic'::text]))),
    CONSTRAINT chat_groups_history_visibility_check CHECK ((history_visibility = ANY (ARRAY['from_join'::text, 'full'::text]))),
    CONSTRAINT chat_groups_scope_type_check CHECK ((scope_type = ANY (ARRAY['internal'::text, 'external'::text]))),
    CONSTRAINT chat_groups_status_check CHECK ((status = ANY (ARRAY['active'::text, 'dissolved'::text]))),
    CONSTRAINT chk_chat_groups_audience_scope CHECK ((audience_scope = ANY (ARRAY['account_social'::text, 'workspace_legacy'::text])))
);


--
-- Name: chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    title text DEFAULT 'Untitled'::text NOT NULL,
    department_id text DEFAULT ''::text NOT NULL,
    agent_id text DEFAULT ''::text NOT NULL,
    codex_thread_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    pinned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);


--
-- Name: cloud_agent_cohort_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_cohort_members (
    cohort_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_family_id text NOT NULL,
    performance_level text DEFAULT 'P1'::text NOT NULL,
    raw_weight double precision DEFAULT 0 NOT NULL,
    effective_weight double precision DEFAULT 0 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_cohort_member_level CHECK ((performance_level = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text, 'P4'::text, 'P5'::text, 'P6'::text, 'P7'::text, 'P8'::text, 'P9'::text, 'P10'::text])))
);


--
-- Name: cloud_agent_cohorts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_cohorts (
    id text NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    department_id text DEFAULT ''::text NOT NULL,
    capability_tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'disabled'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cohort_key text DEFAULT ''::text NOT NULL,
    identity_version text DEFAULT 'cluster_cohort_identity_v1'::text NOT NULL,
    minimum_user_count integer DEFAULT 7 NOT NULL,
    maximum_user_weight_share double precision DEFAULT 0.15 NOT NULL,
    participation_policy_version text DEFAULT 'cluster_active_synced_mandatory_v1'::text NOT NULL,
    CONSTRAINT chk_cloud_cluster_contract_alignment CHECK (((minimum_user_count = 7) AND (maximum_user_weight_share = (0.15)::double precision) AND (participation_policy_version = 'cluster_active_synced_mandatory_v1'::text))),
    CONSTRAINT chk_cloud_cohort_identity CHECK (((cohort_key <> ''::text) AND (identity_version <> ''::text))),
    CONSTRAINT chk_cloud_cohort_status CHECK ((status = ANY (ARRAY['active'::text, 'ineligible'::text, 'inactive'::text])))
);


--
-- Name: cloud_agent_context_spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_context_spaces (
    user_id text NOT NULL,
    id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    context_kind text NOT NULL,
    memory_document_id text,
    project_id text DEFAULT ''::text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    delegation_id text DEFAULT ''::text NOT NULL,
    group_id text DEFAULT ''::text NOT NULL,
    relationship_user_id text DEFAULT ''::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_agent_context_spaces_check CHECK ((((context_kind = 'general_memory'::text) AND (memory_document_id IS NOT NULL) AND (project_id = ''::text) AND (task_run_id = ''::text) AND (relationship_user_id = ''::text)) OR ((context_kind = 'project'::text) AND (memory_document_id IS NULL) AND (project_id <> ''::text) AND (task_run_id = ''::text) AND (relationship_user_id = ''::text)) OR ((context_kind = 'task'::text) AND (memory_document_id IS NULL) AND (task_run_id <> ''::text) AND (project_id = ''::text) AND (relationship_user_id = ''::text)) OR ((context_kind = 'relationship'::text) AND (memory_document_id IS NULL) AND (relationship_user_id <> ''::text) AND (project_id = ''::text) AND (task_run_id = ''::text)))),
    CONSTRAINT cloud_agent_context_spaces_context_kind_check CHECK ((context_kind = ANY (ARRAY['general_memory'::text, 'project'::text, 'task'::text, 'relationship'::text]))),
    CONSTRAINT cloud_agent_context_spaces_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text])))
);


--
-- Name: cloud_agent_context_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_context_states (
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    primary_conversation_id text DEFAULT ''::text NOT NULL,
    active_context_space_id text DEFAULT ''::text NOT NULL,
    active_memory_document_id text DEFAULT ''::text NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    last_command_id text DEFAULT ''::text NOT NULL,
    source_device_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_agent_context_states_state_revision_check CHECK ((state_revision >= 1))
);


--
-- Name: cloud_agent_families_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_families_v3 (
    id text NOT NULL,
    department_id text DEFAULT ''::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    routable boolean DEFAULT false NOT NULL,
    current_version_id text DEFAULT ''::text NOT NULL,
    instance_kind text DEFAULT 'unavailable'::text NOT NULL,
    recruitable boolean DEFAULT false NOT NULL,
    default_for_new_user boolean DEFAULT false NOT NULL,
    quota_cost integer DEFAULT 0 NOT NULL,
    classification_version text DEFAULT 'employee_recruitment_phase_a_v1'::text NOT NULL
);


--
-- Name: cloud_agent_instance_alias_repairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_instance_alias_repairs (
    id text NOT NULL,
    user_id text NOT NULL,
    removed_alias_instance_id text NOT NULL,
    removed_canonical_instance_id text NOT NULL,
    preserved_alias_instance_id text NOT NULL,
    preserved_canonical_instance_id text NOT NULL,
    repair_kind text DEFAULT 'active_winner_two_node_cycle_v1'::text NOT NULL,
    alias_row_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    entity_row_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    change_rows_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_agent_leadership_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_leadership_evaluations (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    task_id text NOT NULL,
    assignment_id text DEFAULT ''::text NOT NULL,
    algorithm_version text NOT NULL,
    score double precision NOT NULL,
    evaluation_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_agent_leadership_evaluations_score_check CHECK (((score >= (0)::double precision) AND (score <= (100)::double precision)))
);


--
-- Name: cloud_agent_leadership_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_leadership_events (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    task_id text DEFAULT ''::text NOT NULL,
    work_scope_id text DEFAULT ''::text NOT NULL,
    assignment_id text DEFAULT ''::text NOT NULL,
    event_kind text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_agent_leadership_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_leadership_history (
    id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    algorithm_version text NOT NULL,
    input_hash text NOT NULL,
    score double precision NOT NULL,
    level text NOT NULL,
    provisional boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_agent_leadership_history_level_check CHECK ((level = ANY (ARRAY['L0'::text, 'L1'::text, 'L2'::text, 'L3'::text]))),
    CONSTRAINT cloud_agent_leadership_history_score_check CHECK (((score >= (0)::double precision) AND (score <= (100)::double precision))),
    CONSTRAINT cloud_agent_leadership_history_status_check CHECK ((status = ANY (ARRAY['active'::text, 'frozen'::text, 'inactive'::text])))
);


--
-- Name: cloud_agent_leadership_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_leadership_levels (
    user_agent_instance_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    score double precision DEFAULT 0 NOT NULL,
    level text DEFAULT 'L0'::text NOT NULL,
    provisional boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    leadership_task_count integer DEFAULT 0 NOT NULL,
    state_revision integer DEFAULT 0 NOT NULL,
    consecutive_low_windows integer DEFAULT 0 NOT NULL,
    last_low_input_hash text DEFAULT ''::text NOT NULL,
    last_low_evaluated_at timestamp with time zone,
    last_low_task_count integer DEFAULT 0 NOT NULL,
    level_changed_at timestamp with time zone,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_agent_leadership_levels_level_check CHECK ((level = ANY (ARRAY['L0'::text, 'L1'::text, 'L2'::text, 'L3'::text]))),
    CONSTRAINT cloud_agent_leadership_levels_score_check CHECK (((score >= (0)::double precision) AND (score <= (100)::double precision))),
    CONSTRAINT cloud_agent_leadership_levels_status_check CHECK ((status = ANY (ARRAY['active'::text, 'frozen'::text, 'inactive'::text])))
);


--
-- Name: cloud_agent_performance_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_performance_events (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    task_id text DEFAULT ''::text NOT NULL,
    task_type_key text DEFAULT 'general'::text NOT NULL,
    event_kind text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_kind text DEFAULT 'legacy_client'::text NOT NULL,
    source_id text DEFAULT ''::text NOT NULL,
    source_version_id text DEFAULT ''::text NOT NULL,
    source_hash text DEFAULT ''::text NOT NULL,
    authority text DEFAULT 'legacy_client'::text NOT NULL,
    validation_status text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT chk_cloud_performance_event_authority_v2 CHECK (((authority = ANY (ARRAY['cloud'::text, 'legacy_client'::text])) AND (validation_status = ANY (ARRAY['validated'::text, 'deferred'::text, 'rejected'::text, 'legacy'::text]))))
);


--
-- Name: cloud_agent_performance_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_performance_history (
    id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    algorithm_version text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    window_ended_at timestamp with time zone NOT NULL,
    input_hash text NOT NULL,
    score double precision NOT NULL,
    level text NOT NULL,
    provisional boolean DEFAULT true NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_performance_history_level CHECK ((level = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text, 'P4'::text, 'P5'::text, 'P6'::text, 'P7'::text, 'P8'::text, 'P9'::text, 'P10'::text]))),
    CONSTRAINT chk_cloud_performance_history_score CHECK (((score >= (0)::double precision) AND (score <= (100)::double precision)))
);


--
-- Name: cloud_agent_performance_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_performance_levels (
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    score double precision DEFAULT 0 NOT NULL,
    level text DEFAULT 'P1'::text NOT NULL,
    provisional boolean DEFAULT true NOT NULL,
    completed_task_count integer DEFAULT 0 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_performance_level CHECK ((level = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text, 'P4'::text, 'P5'::text, 'P6'::text, 'P7'::text, 'P8'::text, 'P9'::text, 'P10'::text]))),
    CONSTRAINT chk_cloud_performance_score CHECK (((score >= (0)::double precision) AND (score <= (100)::double precision) AND (completed_task_count >= 0)))
);


--
-- Name: cloud_agent_versions_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_agent_versions_v3 (
    id text NOT NULL,
    agent_family_id text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_chat_context_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_chat_context_states (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    session_id text NOT NULL,
    context_space_id text DEFAULT ''::text NOT NULL,
    context_epoch integer DEFAULT 1 NOT NULL,
    reset_after_message_id text DEFAULT ''::text NOT NULL,
    reset_after_created_at timestamp with time zone,
    last_execution_id text DEFAULT ''::text NOT NULL,
    last_input_tokens bigint DEFAULT 0 NOT NULL,
    context_window_tokens bigint DEFAULT 0 NOT NULL,
    provider_compaction_detected boolean DEFAULT false NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    last_command_id text DEFAULT ''::text NOT NULL,
    source_device_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_chat_context_states_context_epoch_check CHECK ((context_epoch >= 1)),
    CONSTRAINT cloud_chat_context_states_context_window_tokens_check CHECK ((context_window_tokens >= 0)),
    CONSTRAINT cloud_chat_context_states_last_input_tokens_check CHECK ((last_input_tokens >= 0)),
    CONSTRAINT cloud_chat_context_states_state_revision_check CHECK ((state_revision >= 1))
);


--
-- Name: cloud_cluster_evidence_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_cluster_evidence_claims (
    evidence_id text NOT NULL,
    consumer_id text NOT NULL,
    run_id text NOT NULL,
    claim_state text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal_at timestamp with time zone,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_cluster_evidence_claims_claim_state_check CHECK ((claim_state = ANY (ARRAY['reserved'::text, 'consumed'::text])))
);


--
-- Name: cloud_cluster_run_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_cluster_run_evidence (
    run_id text NOT NULL,
    evidence_id text NOT NULL,
    raw_weight double precision DEFAULT 0 NOT NULL,
    effective_weight double precision DEFAULT 0 NOT NULL,
    cohort_raw_total double precision DEFAULT 0 NOT NULL,
    user_cap double precision DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_conversation_aliases_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_conversation_aliases_v7 (
    user_id text NOT NULL,
    alias_conversation_id text NOT NULL,
    canonical_conversation_id text NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL,
    agent_instance_id text DEFAULT ''::text NOT NULL,
    reason text DEFAULT 'agent_single_window_canonicalization'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_conversation_aliases_v7_check CHECK ((alias_conversation_id <> canonical_conversation_id))
);


--
-- Name: cloud_conversations_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_conversations_v6 (
    user_id text NOT NULL,
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    conversation_role text DEFAULT 'standard'::text NOT NULL,
    write_state text DEFAULT 'writable'::text NOT NULL,
    superseded_by_session_id text DEFAULT ''::text NOT NULL
);


--
-- Name: cloud_device_token_nonces_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_device_token_nonces_v6 (
    user_id text NOT NULL,
    device_id text NOT NULL,
    nonce text NOT NULL,
    proof_timestamp timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_devices_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_devices_v6 (
    user_id text NOT NULL,
    device_id text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    hostname text DEFAULT ''::text NOT NULL,
    platform text DEFAULT ''::text NOT NULL,
    arch text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    public_key_pem text DEFAULT ''::text NOT NULL,
    public_key_fingerprint text DEFAULT ''::text NOT NULL,
    approved_by_device_id text DEFAULT ''::text NOT NULL,
    approved_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_devices_v6_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'revoked'::text])))
);


--
-- Name: cloud_effective_skill_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_effective_skill_projections (
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    market_version_id text DEFAULT ''::text NOT NULL,
    adopted_sections_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    conflicts_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    effective_skill_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_employee_roster_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_employee_roster_states (
    user_id text NOT NULL,
    roster_revision bigint DEFAULT 0 NOT NULL,
    bootstrap_status text DEFAULT 'pending'::text NOT NULL,
    bootstrap_id text DEFAULT ''::text NOT NULL,
    policy_version text DEFAULT 'employee_cloud_authority_v1'::text NOT NULL,
    bootstrapped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_employee_roster_states_bootstrap_status_check CHECK ((bootstrap_status = ANY (ARRAY['pending'::text, 'completed'::text]))),
    CONSTRAINT cloud_employee_roster_states_roster_revision_check CHECK ((roster_revision >= 0))
);


--
-- Name: cloud_evolution_apply_journals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_apply_journals (
    id text NOT NULL,
    run_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    previous_skill_version_id text DEFAULT ''::text NOT NULL,
    next_skill_version_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: cloud_evolution_collection_boundaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_collection_boundaries (
    source_kind text NOT NULL,
    collect_after timestamp with time zone NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_evolution_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evaluations (
    id text NOT NULL,
    run_id text NOT NULL,
    evaluation_kind text NOT NULL,
    case_index integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    regression boolean DEFAULT false NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_evolution_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence (
    evidence_id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    source_version_id text DEFAULT ''::text NOT NULL,
    context_space_id text DEFAULT ''::text NOT NULL,
    task_id text DEFAULT ''::text NOT NULL,
    delegation_id text DEFAULT ''::text NOT NULL,
    content_hash text NOT NULL,
    content_ciphertext text NOT NULL,
    content_nonce text DEFAULT ''::text NOT NULL,
    content_tag text DEFAULT ''::text NOT NULL,
    encryption_algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
    key_id text DEFAULT ''::text NOT NULL,
    confidence double precision DEFAULT 1 NOT NULL,
    privacy_level text DEFAULT 'owner_private'::text NOT NULL,
    quarantine_reason text DEFAULT ''::text NOT NULL,
    occurred_at timestamp with time zone,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    personal_threshold_eligible boolean DEFAULT true NOT NULL,
    eligibility_policy_version text DEFAULT 'personal_threshold_v1'::text NOT NULL,
    lineage_key text DEFAULT ''::text NOT NULL,
    validation_status text DEFAULT 'validated'::text NOT NULL,
    validation_policy_version text DEFAULT 'legacy_backfill_v1'::text NOT NULL,
    validation_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    validated_at timestamp with time zone,
    historical_inactive boolean DEFAULT false NOT NULL,
    wrapped_data_key text DEFAULT ''::text NOT NULL,
    key_wrap_algorithm text DEFAULT ''::text NOT NULL,
    key_version integer DEFAULT 0 NOT NULL,
    envelope_format text DEFAULT 'legacy_symmetric'::text NOT NULL,
    CONSTRAINT chk_cloud_evolution_evidence_validation_status CHECK ((validation_status = ANY (ARRAY['pending_validation'::text, 'validated'::text, 'quarantined'::text, 'failed_retryable'::text])))
);

ALTER TABLE ONLY public.cloud_evolution_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: cloud_evolution_evidence_access_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence_access_audits (
    id text NOT NULL,
    worker_identity text NOT NULL,
    run_id text DEFAULT ''::text NOT NULL,
    evidence_id text DEFAULT ''::text NOT NULL,
    purpose text NOT NULL,
    result text NOT NULL,
    result_code text DEFAULT ''::text NOT NULL,
    key_id text DEFAULT ''::text NOT NULL,
    detail_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_evidence_access_result CHECK ((result = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text])))
);


--
-- Name: cloud_evolution_evidence_quarantine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence_quarantine (
    id text NOT NULL,
    evidence_id text DEFAULT ''::text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    user_agent_instance_id text DEFAULT ''::text NOT NULL,
    source_kind text DEFAULT ''::text NOT NULL,
    source_id text DEFAULT ''::text NOT NULL,
    source_version_id text DEFAULT ''::text NOT NULL,
    reason_code text NOT NULL,
    reason_text text DEFAULT ''::text NOT NULL,
    retryable boolean DEFAULT false NOT NULL,
    resolution_status text DEFAULT 'pending'::text NOT NULL,
    resolution_note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT chk_cloud_evidence_quarantine_resolution CHECK ((resolution_status = ANY (ARRAY['pending'::text, 'released'::text, 'rejected'::text, 'resolved'::text])))
);


--
-- Name: cloud_evolution_evidence_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence_usage (
    evidence_id text NOT NULL,
    evolution_scope text NOT NULL,
    consumer_id text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    run_id text DEFAULT ''::text NOT NULL,
    algorithm_version text DEFAULT ''::text NOT NULL,
    re_evaluation_basis_hash text DEFAULT ''::text NOT NULL,
    rejection_kind text DEFAULT ''::text NOT NULL,
    transition_reason text DEFAULT ''::text NOT NULL,
    reserved_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    terminal_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_evidence_rejection_kind CHECK ((rejection_kind = ANY (ARRAY[''::text, 'gate'::text, 'hr_review'::text, 'regression'::text, 'privacy'::text, 'mixed'::text, 'user_rejected'::text, 'invalid_source'::text, 'legacy_unknown'::text]))),
    CONSTRAINT chk_cloud_evidence_rejection_state CHECK ((((status = 'evaluated_rejected'::text) AND (rejection_kind <> ''::text)) OR ((status <> 'evaluated_rejected'::text) AND (rejection_kind = ''::text)))),
    CONSTRAINT chk_cloud_evidence_scope CHECK ((evolution_scope = ANY (ARRAY['personal'::text, 'cluster'::text]))),
    CONSTRAINT chk_cloud_evidence_usage_status CHECK ((status = ANY (ARRAY['available'::text, 'reserved'::text, 'consumed'::text, 'evaluated_rejected'::text, 'released'::text])))
);


--
-- Name: cloud_evolution_evidence_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence_usage_events (
    id text NOT NULL,
    evidence_id text NOT NULL,
    evolution_scope text NOT NULL,
    consumer_id text NOT NULL,
    from_status text DEFAULT ''::text NOT NULL,
    to_status text NOT NULL,
    run_id text DEFAULT ''::text NOT NULL,
    algorithm_version text DEFAULT ''::text NOT NULL,
    rejection_kind text DEFAULT ''::text NOT NULL,
    transition_reason text DEFAULT ''::text NOT NULL,
    re_evaluation_basis_hash text DEFAULT ''::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_evolution_evidence_usage_events_evolution_scope_check CHECK ((evolution_scope = ANY (ARRAY['personal'::text, 'cluster'::text]))),
    CONSTRAINT cloud_evolution_evidence_usage_events_to_status_check CHECK ((to_status = ANY (ARRAY['available'::text, 'reserved'::text, 'consumed'::text, 'evaluated_rejected'::text, 'released'::text])))
);


--
-- Name: cloud_evolution_evidence_validation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_evidence_validation_jobs (
    evidence_id text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text DEFAULT ''::text NOT NULL,
    claimed_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    error_code text DEFAULT ''::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_cloud_evidence_validation_job_status CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'completed'::text, 'failed_retryable'::text, 'failed_terminal'::text, 'quarantined'::text])))
);


--
-- Name: cloud_evolution_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_jobs (
    id text NOT NULL,
    run_id text NOT NULL,
    job_kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text DEFAULT ''::text NOT NULL,
    lease_expires_at timestamp with time zone,
    error_code text DEFAULT ''::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_cloud_evolution_job_attempts CHECK (((attempt_count >= 0) AND (max_attempts >= 1))),
    CONSTRAINT chk_cloud_evolution_job_kind CHECK ((job_kind = ANY (ARRAY['personal_evolution'::text, 'cluster_evolution'::text, 'cluster_shadow'::text, 'cluster_canary'::text, 'market_health'::text]))),
    CONSTRAINT chk_cloud_evolution_job_status CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'waiting_canary'::text, 'completed'::text, 'failed_retryable'::text, 'failed_terminal'::text, 'cancelled'::text])))
);


--
-- Name: cloud_evolution_key_rotation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_key_rotation_jobs (
    evidence_id text NOT NULL,
    target_key_id text NOT NULL,
    source_key_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text DEFAULT ''::text NOT NULL,
    claimed_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    error_code text DEFAULT ''::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_evolution_key_rotation_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'completed'::text, 'failed_retryable'::text, 'quarantined'::text])))
);


--
-- Name: cloud_evolution_run_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_run_snapshots (
    run_id text NOT NULL,
    snapshot_hash text NOT NULL,
    evidence_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    base_skill_ciphertext text DEFAULT ''::text NOT NULL,
    personal_overlay_ciphertext text DEFAULT ''::text NOT NULL,
    memory_manifest_ciphertext text DEFAULT ''::text NOT NULL,
    encryption_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cohort_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    canary_cases_ciphertext text DEFAULT ''::text NOT NULL,
    canary_cases_nonce text DEFAULT ''::text NOT NULL,
    canary_cases_tag text DEFAULT ''::text NOT NULL,
    canary_cases_algorithm text DEFAULT ''::text NOT NULL,
    canary_cases_key_id text DEFAULT ''::text NOT NULL,
    shadow_cases_ciphertext text DEFAULT ''::text NOT NULL,
    shadow_cases_nonce text DEFAULT ''::text NOT NULL,
    shadow_cases_tag text DEFAULT ''::text NOT NULL,
    shadow_cases_algorithm text DEFAULT ''::text NOT NULL,
    shadow_cases_key_id text DEFAULT ''::text NOT NULL
);


--
-- Name: cloud_evolution_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_evolution_runs (
    id text NOT NULL,
    evolution_scope text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    user_agent_instance_id text DEFAULT ''::text NOT NULL,
    agent_family_id text NOT NULL,
    cohort_id text DEFAULT ''::text NOT NULL,
    consumer_id text NOT NULL,
    algorithm_version text NOT NULL,
    trigger_kind text DEFAULT 'scheduled'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    evidence_count integer DEFAULT 0 NOT NULL,
    base_agent_version_id text DEFAULT ''::text NOT NULL,
    base_personal_skill_version_id text DEFAULT ''::text NOT NULL,
    candidate_personal_skill_version_id text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    error_code text DEFAULT ''::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_cloud_evolution_run_count CHECK ((evidence_count >= 0)),
    CONSTRAINT chk_cloud_evolution_run_identity CHECK ((((evolution_scope = 'personal'::text) AND (owner_user_id <> ''::text) AND (user_agent_instance_id <> ''::text) AND (cohort_id = ''::text) AND (consumer_id = user_agent_instance_id)) OR ((evolution_scope = 'cluster'::text) AND (cohort_id <> ''::text) AND (user_agent_instance_id = ''::text) AND (consumer_id = cohort_id)))),
    CONSTRAINT chk_cloud_evolution_run_scope CHECK ((evolution_scope = ANY (ARRAY['personal'::text, 'cluster'::text]))),
    CONSTRAINT chk_cloud_evolution_run_status CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'proposed'::text, 'available'::text, 'canary'::text, 'applied'::text, 'failed_retryable'::text, 'failed_terminal'::text, 'evaluated_rejected'::text, 'rolled_back'::text, 'skipped'::text, 'insufficient_evidence'::text]))),
    CONSTRAINT chk_cloud_evolution_run_trigger CHECK ((trigger_kind = ANY (ARRAY['manual'::text, 'scheduled'::text])))
);


--
-- Name: cloud_file_objects_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_file_objects_v6 (
    user_id text NOT NULL,
    sha256 text NOT NULL,
    object_key text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    storage_status text DEFAULT 'pending'::text NOT NULL,
    reference_count bigint DEFAULT 0 NOT NULL,
    checksum_verified boolean DEFAULT false NOT NULL,
    upload_expires_at timestamp with time zone,
    unreferenced_at timestamp with time zone,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_file_objects_v6_storage_status_check CHECK ((storage_status = ANY (ARRAY['pending'::text, 'uploaded'::text, 'verified'::text, 'failed'::text, 'deleted'::text])))
);


--
-- Name: cloud_file_refs_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_file_refs_v6 (
    user_id text NOT NULL,
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_leadership_appeals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_leadership_appeals (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    leadership_action_id text DEFAULT ''::text NOT NULL,
    appeal_kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    command_id text DEFAULT ''::text NOT NULL,
    submitted_reason text DEFAULT ''::text NOT NULL,
    reviewer_user_id text DEFAULT ''::text NOT NULL,
    reviewer_reason text DEFAULT ''::text NOT NULL,
    evidence_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_leadership_appeals_appeal_kind_check CHECK ((appeal_kind = ANY (ARRAY['assessment'::text, 'promotion'::text, 'demotion'::text, 'freeze'::text, 'restore'::text]))),
    CONSTRAINT cloud_leadership_appeals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text])))
);


--
-- Name: cloud_leadership_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_leadership_assignments (
    id text NOT NULL,
    work_scope_id text NOT NULL,
    user_id text NOT NULL,
    agent_instance_id text NOT NULL,
    role text NOT NULL,
    leadership_level_snapshot text DEFAULT ''::text NOT NULL,
    permission_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    appointed_by_user_id text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    assignment_mode text DEFAULT 'normal'::text NOT NULL,
    limit_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT chk_cloud_leadership_assignment_mode CHECK ((assignment_mode = ANY (ARRAY['normal'::text, 'trial'::text])))
);


--
-- Name: cloud_leadership_promotion_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_leadership_promotion_actions (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    action text NOT NULL,
    from_level text DEFAULT 'L0'::text NOT NULL,
    to_level text DEFAULT 'L0'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    command_id text DEFAULT ''::text NOT NULL,
    actor_id text DEFAULT ''::text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    evidence_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_leadership_promotion_actions_action_check CHECK ((action = ANY (ARRAY['trial_requested'::text, 'trial_approved'::text, 'promote'::text, 'reject'::text, 'demote'::text, 'freeze'::text, 'restore'::text]))),
    CONSTRAINT cloud_leadership_promotion_actions_from_level_check CHECK ((from_level = ANY (ARRAY['L0'::text, 'L1'::text, 'L2'::text, 'L3'::text]))),
    CONSTRAINT cloud_leadership_promotion_actions_to_level_check CHECK ((to_level = ANY (ARRAY['L0'::text, 'L1'::text, 'L2'::text, 'L3'::text])))
);


--
-- Name: cloud_market_adoption_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_adoption_actions (
    id text NOT NULL,
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    market_version_id text NOT NULL,
    section_id text NOT NULL,
    action text NOT NULL,
    conflict_resolution text DEFAULT 'none'::text NOT NULL,
    previous_status text DEFAULT ''::text NOT NULL,
    next_status text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    command_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: cloud_market_agent_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_agent_candidates (
    id text NOT NULL,
    cohort_id text NOT NULL,
    agent_family_id text NOT NULL,
    status text DEFAULT 'disabled'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id text DEFAULT ''::text NOT NULL,
    revision_no integer DEFAULT 0 NOT NULL,
    diagnosis_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    gate_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    governance_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    canary_started_at timestamp with time zone,
    canary_deadline_at timestamp with time zone,
    released_at timestamp with time zone,
    suspended_at timestamp with time zone,
    status_reason text DEFAULT ''::text NOT NULL,
    shadow_started_at timestamp with time zone,
    shadow_completed_at timestamp with time zone,
    CONSTRAINT chk_cloud_market_candidate_status CHECK ((status = ANY (ARRAY['draft'::text, 'gated'::text, 'governance_approved'::text, 'shadow_passed'::text, 'canary_running'::text, 'canary_passed'::text, 'released'::text, 'gate_rejected'::text, 'governance_rejected'::text, 'regression_rejected'::text, 'privacy_rejected'::text, 'canary_rejected'::text, 'rolled_back'::text, 'archived'::text])))
);


--
-- Name: cloud_market_agent_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_agent_versions (
    id text NOT NULL,
    agent_family_id text NOT NULL,
    parent_version_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'disabled'::text NOT NULL,
    sections_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    suspended_at timestamp with time zone,
    status_reason text DEFAULT ''::text NOT NULL,
    health_baseline_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    version_kind text DEFAULT 'legacy_sections'::text NOT NULL,
    base_agent_version_id text DEFAULT ''::text NOT NULL,
    CONSTRAINT chk_cloud_market_version_kind CHECK ((version_kind = ANY (ARRAY['market_base'::text, 'legacy_sections'::text]))),
    CONSTRAINT chk_cloud_market_version_status CHECK ((status = ANY (ARRAY['draft'::text, 'released'::text, 'suspended'::text, 'rolled_back'::text, 'rejected'::text, 'archived'::text])))
);


--
-- Name: cloud_market_canary_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_canary_assignments (
    candidate_id text NOT NULL,
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    policy_version text DEFAULT 'market_canary_real_user_default_on_v2'::text NOT NULL,
    status text NOT NULL,
    baseline_score double precision DEFAULT 0 NOT NULL,
    baseline_failure_rate double precision DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT cloud_market_canary_assignments_status_check CHECK ((status = ANY (ARRAY['enrolled'::text, 'completed'::text, 'withdrawn'::text, 'rejected'::text])))
);


--
-- Name: cloud_market_canary_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_canary_evaluations (
    id text NOT NULL,
    candidate_id text NOT NULL,
    policy_version text DEFAULT 'market_canary_real_user_default_on_v2'::text NOT NULL,
    status text NOT NULL,
    user_count integer DEFAULT 0 NOT NULL,
    case_count integer DEFAULT 0 NOT NULL,
    baseline_score double precision DEFAULT 0 NOT NULL,
    candidate_score double precision DEFAULT 0 NOT NULL,
    baseline_failure_rate double precision DEFAULT 0 NOT NULL,
    candidate_failure_rate double precision DEFAULT 0 NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_market_canary_evaluations_status_check CHECK ((status = ANY (ARRAY['insufficient'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: cloud_market_canary_opt_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_canary_opt_ins (
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    policy_version text DEFAULT 'market_canary_real_user_default_on_v2'::text NOT NULL,
    status text NOT NULL,
    command_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_market_canary_opt_ins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'withdrawn'::text])))
);


--
-- Name: cloud_market_candidate_family_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_candidate_family_sections (
    candidate_id text NOT NULL,
    agent_family_id text NOT NULL,
    section_id text NOT NULL,
    title text NOT NULL,
    content_hash text NOT NULL,
    content_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    support_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'canary'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_market_candidate_privacy_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_candidate_privacy_reviews (
    id text NOT NULL,
    candidate_id text NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    review_stage text NOT NULL,
    deterministic_status text NOT NULL,
    reviewer_status text NOT NULL,
    finding_codes_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    review_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_market_candidate_section_supports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_candidate_section_supports (
    candidate_id text NOT NULL,
    agent_family_id text NOT NULL,
    section_id text NOT NULL,
    evidence_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    contributor_id text NOT NULL,
    evidence_handle text NOT NULL,
    support_confidence numeric NOT NULL,
    deterministic_pass boolean DEFAULT false NOT NULL,
    reviewer_pass boolean DEFAULT false NOT NULL,
    review_stage text DEFAULT 'initial_gate'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_market_support_confidence CHECK (((support_confidence >= (0)::numeric) AND (support_confidence <= (1)::numeric)))
);


--
-- Name: cloud_market_candidate_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_candidate_sections (
    candidate_id text NOT NULL,
    section_id text NOT NULL,
    title text NOT NULL,
    content_hash text NOT NULL,
    content_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    support_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_market_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_evaluations (
    id text NOT NULL,
    candidate_id text NOT NULL,
    evaluation_kind text NOT NULL,
    case_index integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    regression boolean DEFAULT false NOT NULL,
    privacy_violation boolean DEFAULT false NOT NULL,
    role_violation boolean DEFAULT false NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_market_version_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_version_health (
    market_version_id text NOT NULL,
    user_count integer DEFAULT 0 NOT NULL,
    observed_task_count integer DEFAULT 0 NOT NULL,
    baseline_score double precision DEFAULT 0 NOT NULL,
    latest_score double precision DEFAULT 0 NOT NULL,
    baseline_failure_rate double precision DEFAULT 0 NOT NULL,
    latest_failure_rate double precision DEFAULT 0 NOT NULL,
    consecutive_regression_windows integer DEFAULT 0 NOT NULL,
    last_input_hash text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'collecting'::text NOT NULL,
    status_reason text DEFAULT ''::text NOT NULL,
    evaluated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_market_version_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_market_version_sections (
    market_version_id text NOT NULL,
    section_id text NOT NULL,
    title text NOT NULL,
    content_hash text NOT NULL,
    content_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_memory_access_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_memory_access_audits (
    id text NOT NULL,
    requester_identity text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    memory_document_id text DEFAULT ''::text NOT NULL,
    evidence_id text DEFAULT ''::text NOT NULL,
    run_id text DEFAULT ''::text NOT NULL,
    purpose text NOT NULL,
    result text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requester_user_id text DEFAULT ''::text NOT NULL,
    requester_agent_instance_id text DEFAULT ''::text NOT NULL,
    target_agent_instance_id text DEFAULT ''::text NOT NULL,
    context_space_id text DEFAULT ''::text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    memory_cloud_key text DEFAULT ''::text NOT NULL,
    memory_document_version_id text DEFAULT ''::text NOT NULL,
    action text DEFAULT 'evolution_read'::text NOT NULL,
    requested_reason text DEFAULT ''::text NOT NULL,
    result_code text DEFAULT ''::text NOT NULL
);


--
-- Name: cloud_memory_document_aliases_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_memory_document_aliases_v3 (
    user_id text NOT NULL,
    alias_document_id text NOT NULL,
    canonical_document_id text NOT NULL,
    reason text DEFAULT 'cross_device_memory_conflict'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_memory_document_versions_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_memory_document_versions_v3 (
    user_id text NOT NULL,
    id text NOT NULL,
    memory_document_id text NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    base_version_id text DEFAULT ''::text NOT NULL,
    parent_version_id text DEFAULT ''::text NOT NULL,
    branch_id text DEFAULT 'main'::text NOT NULL,
    conflict_state text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT chk_cloud_memory_version_no CHECK ((version_no >= 1))
);


--
-- Name: cloud_memory_documents_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_memory_documents_v3 (
    user_id text NOT NULL,
    id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    scope text DEFAULT 'general'::text NOT NULL,
    slot_no integer DEFAULT 0 NOT NULL,
    current_version_id text DEFAULT ''::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    sync_enabled boolean DEFAULT true NOT NULL,
    allow_personal_evolution boolean DEFAULT true NOT NULL,
    allow_cluster_evolution boolean DEFAULT false NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text DEFAULT 'memory0.md'::text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    project_id text DEFAULT ''::text NOT NULL,
    relationship_id text DEFAULT ''::text NOT NULL,
    context_space_id text DEFAULT ''::text NOT NULL,
    visibility text DEFAULT 'agent_private'::text NOT NULL,
    source_conversation_cursor text DEFAULT ''::text NOT NULL,
    encryption_key_id text DEFAULT ''::text NOT NULL,
    consent_scope_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    cloud_key text DEFAULT ''::text NOT NULL,
    delegation_id text DEFAULT ''::text NOT NULL,
    group_id text DEFAULT ''::text NOT NULL,
    relationship_user_id text DEFAULT ''::text NOT NULL,
    CONSTRAINT chk_cloud_memory_lifecycle CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text]))),
    CONSTRAINT chk_cloud_memory_scope CHECK ((scope = ANY (ARRAY['general'::text, 'task'::text, 'project'::text, 'relationship'::text]))),
    CONSTRAINT chk_cloud_memory_slot CHECK ((slot_no >= 0)),
    CONSTRAINT chk_cloud_memory_visibility CHECK ((visibility = ANY (ARRAY['agent_private'::text, 'owner_private'::text, 'work_collaborators'::text, 'work_leadership'::text, 'work_participants'::text, 'work_summary'::text])))
);


--
-- Name: cloud_memory_sync_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_memory_sync_mappings (
    owner_user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    cloud_key text NOT NULL,
    memory_document_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_memory_sync_mappings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'revoked'::text])))
);


--
-- Name: cloud_messages_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_messages_v6 (
    user_id text NOT NULL,
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_space_id text DEFAULT ''::text NOT NULL
);


--
-- Name: cloud_model_executions_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_model_executions_v6 (
    user_id text NOT NULL,
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_performance_backfill_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_performance_backfill_cursors (
    cursor_key text NOT NULL,
    last_updated_at timestamp with time zone,
    last_source_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_performance_cursor_status CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])))
);


--
-- Name: cloud_personal_evolution_actions_v4; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_evolution_actions_v4 (
    user_id text NOT NULL,
    id text NOT NULL,
    proposal_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text DEFAULT ''::text NOT NULL,
    decision text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    actor_device_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_personal_evolution_memory_operations_v4; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_evolution_memory_operations_v4 (
    user_id text NOT NULL,
    id text NOT NULL,
    proposal_id text NOT NULL,
    memory_document_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_memory_operation_status CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text])))
);


--
-- Name: cloud_personal_evolution_proposals_v4; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_evolution_proposals_v4 (
    user_id text NOT NULL,
    id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    proposal_hash text DEFAULT ''::text NOT NULL,
    origin_device_id text DEFAULT 'cloud-authority'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_personal_proposal_status CHECK ((status = ANY (ARRAY['ready'::text, 'partially_applied'::text, 'applied'::text, 'rejected'::text, 'legacy_proposal_stale'::text])))
);


--
-- Name: cloud_personal_evolution_schedule_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_evolution_schedule_states (
    user_agent_instance_id text NOT NULL,
    last_evaluated_at timestamp with time zone,
    next_eligible_at timestamp with time zone DEFAULT now() NOT NULL,
    last_status text DEFAULT 'never_evaluated'::text NOT NULL,
    last_evidence_count integer DEFAULT 0 NOT NULL,
    last_run_id text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_personal_schedule_count CHECK ((last_evidence_count >= 0)),
    CONSTRAINT chk_cloud_personal_schedule_status CHECK ((last_status = ANY (ARRAY['never_evaluated'::text, 'insufficient_evidence'::text, 'queued'::text, 'applied'::text, 'evaluated_rejected'::text, 'failed_retryable'::text, 'failed_terminal'::text, 'legacy_proposal_stale'::text])))
);


--
-- Name: cloud_personal_skill_overlay_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_skill_overlay_versions (
    id text NOT NULL,
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    agent_family_id text NOT NULL,
    base_agent_version_id text DEFAULT ''::text NOT NULL,
    parent_version_id text DEFAULT ''::text NOT NULL,
    source_run_id text DEFAULT ''::text NOT NULL,
    authority text DEFAULT 'cloud'::text NOT NULL,
    stability_status text DEFAULT 'candidate'::text NOT NULL,
    status text DEFAULT 'candidate'::text NOT NULL,
    overlay_hash text DEFAULT ''::text NOT NULL,
    effective_skill_hash text DEFAULT ''::text NOT NULL,
    compiler_version text DEFAULT 'overlay_concat_v1'::text NOT NULL,
    content_ciphertext text DEFAULT ''::text NOT NULL,
    content_nonce text DEFAULT ''::text NOT NULL,
    content_tag text DEFAULT ''::text NOT NULL,
    encryption_algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
    key_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    archived_at timestamp with time zone,
    CONSTRAINT chk_cloud_overlay_authority CHECK ((authority = 'cloud'::text)),
    CONSTRAINT chk_cloud_overlay_stability CHECK ((stability_status = ANY (ARRAY['candidate'::text, 'stable'::text]))),
    CONSTRAINT chk_cloud_overlay_status CHECK ((status = ANY (ARRAY['candidate'::text, 'active'::text, 'archived'::text, 'rejected'::text])))
);


--
-- Name: cloud_personal_version_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_version_commands (
    user_id text NOT NULL,
    command_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    action text NOT NULL,
    target_version_id text DEFAULT ''::text NOT NULL,
    expected_active_version_id text DEFAULT ''::text NOT NULL,
    previous_active_version_id text DEFAULT ''::text NOT NULL,
    result_active_version_id text DEFAULT ''::text NOT NULL,
    actor_device_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    error_code text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: cloud_personal_version_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_personal_version_health (
    personal_skill_version_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    baseline_score double precision DEFAULT 0 NOT NULL,
    baseline_failure_rate double precision DEFAULT 0 NOT NULL,
    observed_task_count integer DEFAULT 0 NOT NULL,
    latest_score double precision DEFAULT 0 NOT NULL,
    latest_failure_rate double precision DEFAULT 0 NOT NULL,
    consecutive_regression_windows integer DEFAULT 0 NOT NULL,
    last_performance_input_hash text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'collecting'::text NOT NULL,
    evaluated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_version_health_status CHECK ((status = ANY (ARRAY['collecting'::text, 'healthy'::text, 'regressing'::text, 'rollback_required'::text, 'rolled_back'::text]))),
    CONSTRAINT chk_cloud_version_health_values CHECK (((observed_task_count >= 0) AND (consecutive_regression_windows >= 0)))
);


--
-- Name: cloud_projects_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_projects_v6 (
    user_id text NOT NULL,
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_batches_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_batches_v6 (
    id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    client_cursor text DEFAULT ''::text NOT NULL,
    accepted_cursor text DEFAULT ''::text NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    conflict_count integer DEFAULT 0 NOT NULL,
    payload_hash text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_batches_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_batches_v8 (
    id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    client_cursor text DEFAULT ''::text NOT NULL,
    accepted_cursor text DEFAULT ''::text NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    conflict_count integer DEFAULT 0 NOT NULL,
    payload_hash text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_changes_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_changes_v6 (
    sequence_id bigint NOT NULL,
    change_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    batch_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    operation text NOT NULL,
    base_revision bigint DEFAULT 0 NOT NULL,
    revision bigint NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_sync_changes_v6_operation_check CHECK ((operation = ANY (ARRAY['upsert'::text, 'delete'::text])))
);


--
-- Name: cloud_sync_changes_v6_sequence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cloud_sync_changes_v6_sequence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cloud_sync_changes_v6_sequence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cloud_sync_changes_v6_sequence_id_seq OWNED BY public.cloud_sync_changes_v6.sequence_id;


--
-- Name: cloud_sync_changes_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_changes_v8 (
    sequence_id bigint NOT NULL,
    change_id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    batch_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    operation text NOT NULL,
    base_revision bigint DEFAULT 0 NOT NULL,
    revision bigint NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_sync_changes_v8_operation_check CHECK ((operation = ANY (ARRAY['upsert'::text, 'delete'::text])))
);


--
-- Name: cloud_sync_changes_v8_sequence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cloud_sync_changes_v8_sequence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cloud_sync_changes_v8_sequence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cloud_sync_changes_v8_sequence_id_seq OWNED BY public.cloud_sync_changes_v8.sequence_id;


--
-- Name: cloud_sync_compaction_states_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_compaction_states_v7 (
    user_id text NOT NULL,
    compacted_through bigint DEFAULT 0 NOT NULL,
    last_snapshot_cursor bigint DEFAULT 0 NOT NULL,
    last_compacted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_compaction_states_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_compaction_states_v8 (
    account_id text NOT NULL,
    compacted_through bigint DEFAULT 0 NOT NULL,
    last_snapshot_cursor bigint DEFAULT 0 NOT NULL,
    last_compacted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_conflicts_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_conflicts_v6 (
    id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    batch_id text DEFAULT ''::text NOT NULL,
    change_id text DEFAULT ''::text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    conflict_kind text NOT NULL,
    server_revision bigint DEFAULT 0 NOT NULL,
    client_base_revision bigint DEFAULT 0 NOT NULL,
    server_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'preserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: cloud_sync_conflicts_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_conflicts_v8 (
    id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    batch_id text NOT NULL,
    change_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    conflict_kind text NOT NULL,
    server_revision bigint DEFAULT 0 NOT NULL,
    client_base_revision bigint DEFAULT 0 NOT NULL,
    server_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'preserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_device_cursors_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_device_cursors_v7 (
    user_id text NOT NULL,
    device_id text NOT NULL,
    last_cursor bigint DEFAULT 0 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    reset_count integer DEFAULT 0 NOT NULL
);


--
-- Name: cloud_sync_device_cursors_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_device_cursors_v8 (
    account_id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    last_cursor bigint DEFAULT 0 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    reset_count integer DEFAULT 0 NOT NULL
);


--
-- Name: cloud_sync_entities_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_entities_v6 (
    user_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    origin_device_id text DEFAULT ''::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_entities_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_entities_v8 (
    account_id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    origin_user_id text DEFAULT ''::text NOT NULL,
    origin_device_id text DEFAULT ''::text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_grants (
    id text NOT NULL,
    user_id text NOT NULL,
    device_id text NOT NULL,
    token_hash text NOT NULL,
    scopes_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grant_version integer DEFAULT 6 NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: cloud_sync_history_repairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_history_repairs (
    id text NOT NULL,
    user_id text NOT NULL,
    repair_kind text DEFAULT 'alias_cycle_history_snapshot_v1'::text NOT NULL,
    repair_status text DEFAULT 'prepared'::text NOT NULL,
    snapshot_cursor bigint NOT NULL,
    deleted_change_count integer DEFAULT 0 NOT NULL,
    replacement_entity_count integer DEFAULT 0 NOT NULL,
    previous_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    previous_compaction_state_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_changes_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    replacement_entities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT cloud_sync_history_repairs_repair_status_check CHECK ((repair_status = ANY (ARRAY['prepared'::text, 'completed'::text])))
);


--
-- Name: cloud_sync_rate_limits_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_rate_limits_v7 (
    user_id text NOT NULL,
    device_id text NOT NULL,
    operation text NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_snapshots_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_snapshots_v7 (
    user_id text NOT NULL,
    snapshot_cursor bigint DEFAULT 0 NOT NULL,
    entity_count integer DEFAULT 0 NOT NULL,
    entities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_snapshots_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_snapshots_v8 (
    account_id text NOT NULL,
    snapshot_cursor bigint DEFAULT 0 NOT NULL,
    entity_count integer DEFAULT 0 NOT NULL,
    entities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_usage_v7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_usage_v7 (
    user_id text NOT NULL,
    verified_storage_bytes bigint DEFAULT 0 NOT NULL,
    pending_storage_bytes bigint DEFAULT 0 NOT NULL,
    last_change_cursor bigint DEFAULT 0 NOT NULL,
    change_count bigint DEFAULT 0 NOT NULL,
    conflict_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_usage_v8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_sync_usage_v8 (
    account_id text NOT NULL,
    last_change_cursor bigint DEFAULT 0 NOT NULL,
    change_count bigint DEFAULT 0 NOT NULL,
    conflict_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_task_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_events (
    id text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    task_node_id text DEFAULT ''::text NOT NULL,
    event_type text DEFAULT ''::text NOT NULL,
    owner_user_id text NOT NULL,
    user_agent_instance_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_task_key_access_audits_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_key_access_audits_v6 (
    id text NOT NULL,
    user_id text NOT NULL,
    task_run_id text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    requesting_device_id text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    reason_code text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_task_key_device_envelopes_v6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_key_device_envelopes_v6 (
    user_id text NOT NULL,
    task_run_id text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    device_id text NOT NULL,
    wrapping_algorithm text DEFAULT 'rsa-oaep-sha256'::text NOT NULL,
    public_key_fingerprint text NOT NULL,
    wrapped_key text NOT NULL,
    source_cloud_key_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_task_key_device_envelopes_v6_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'superseded'::text])))
);


--
-- Name: cloud_task_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_nodes (
    id text NOT NULL,
    task_run_id text DEFAULT ''::text NOT NULL,
    user_agent_instance_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_runs (
    id text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);


--
-- Name: cloud_task_security_contexts_v5; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_task_security_contexts_v5 (
    user_id text NOT NULL,
    task_run_id text NOT NULL,
    owner_user_id text DEFAULT ''::text NOT NULL,
    local_key_id text NOT NULL,
    cloud_key_id text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    cloud_evolution_allowed boolean DEFAULT false NOT NULL,
    cloud_collaboration_allowed boolean DEFAULT false NOT NULL,
    local_envelope_state text DEFAULT 'reference_only'::text NOT NULL,
    cloud_envelope_state text DEFAULT 'disabled'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cloud_sync_recovery_allowed boolean DEFAULT true NOT NULL
);


--
-- Name: cloud_user_agent_instance_aliases_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_user_agent_instance_aliases_v3 (
    user_id text NOT NULL,
    alias_instance_id text NOT NULL,
    canonical_instance_id text NOT NULL,
    reason text DEFAULT 'cross_device_family_conflict'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_user_agent_instances_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_user_agent_instances_v3 (
    user_id text NOT NULL,
    id text NOT NULL,
    agent_family_id text NOT NULL,
    base_agent_version_id text DEFAULT ''::text NOT NULL,
    active_personal_skill_version_id text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    sync_enabled boolean DEFAULT true NOT NULL,
    personal_evolution_consent boolean DEFAULT true NOT NULL,
    cluster_contribution_consent boolean DEFAULT false NOT NULL,
    personal_skill_auto_activate boolean DEFAULT false NOT NULL,
    source_device_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    instance_kind text DEFAULT 'employee'::text NOT NULL,
    employment_state text DEFAULT 'active'::text NOT NULL,
    quota_exempt boolean DEFAULT false NOT NULL,
    recruited_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    last_state_changed_at timestamp with time zone,
    state_revision integer DEFAULT 1 NOT NULL,
    recruitment_source text DEFAULT 'migration'::text NOT NULL,
    policy_version text DEFAULT 'employee_cloud_authority_v1'::text NOT NULL,
    family_instance_seq integer DEFAULT 0 NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    CONSTRAINT chk_cloud_agent_employment_state CHECK ((employment_state = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT chk_cloud_agent_instance_kind CHECK ((instance_kind = ANY (ARRAY['employee'::text, 'system'::text, 'governance'::text, 'unavailable'::text]))),
    CONSTRAINT chk_cloud_agent_instance_status CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT chk_cloud_agent_state_consistency CHECK ((status = employment_state)),
    CONSTRAINT chk_cloud_agent_state_revision CHECK ((state_revision >= 1)),
    CONSTRAINT chk_cloud_cluster_participation_authority CHECK (((personal_evolution_consent = cluster_contribution_consent) AND (personal_skill_auto_activate = false)))
);


--
-- Name: cloud_user_agent_recruitment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_user_agent_recruitment_events (
    id text NOT NULL,
    user_id text NOT NULL,
    user_agent_instance_id text DEFAULT ''::text NOT NULL,
    agent_family_id text NOT NULL,
    event_type text NOT NULL,
    previous_state text DEFAULT ''::text NOT NULL,
    next_state text DEFAULT ''::text NOT NULL,
    quota_before integer DEFAULT 0 NOT NULL,
    quota_after integer DEFAULT 0 NOT NULL,
    command_id text NOT NULL,
    source_device_id text DEFAULT ''::text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_user_evolution_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_user_evolution_preferences (
    user_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    policy_version text DEFAULT 'evolution_mandatory_upload_v1'::text NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    last_command_id text DEFAULT ''::text NOT NULL,
    paused_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cloud_evolution_preference_mandatory CHECK ((enabled = true)),
    CONSTRAINT cloud_user_evolution_preferences_state_revision_check CHECK ((state_revision >= 1))
);


--
-- Name: cloud_user_market_adoptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_user_market_adoptions (
    user_id text NOT NULL,
    user_agent_instance_id text NOT NULL,
    market_version_id text NOT NULL,
    section_id text DEFAULT '*'::text NOT NULL,
    status text DEFAULT 'disabled'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    adoption_mode text DEFAULT 'sections'::text NOT NULL,
    CONSTRAINT chk_cloud_market_adoption_mode CHECK ((adoption_mode = ANY (ARRAY['full'::text, 'sections'::text]))),
    CONSTRAINT chk_cloud_market_adoption_status CHECK ((status = ANY (ARRAY['adopted'::text, 'superseded'::text, 'rolled_back'::text, 'ignored'::text])))
);


--
-- Name: cloud_work_memory_access_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_work_memory_access_audits (
    id text NOT NULL,
    requester_user_id text NOT NULL,
    requester_agent_instance_id text DEFAULT ''::text NOT NULL,
    target_user_id text DEFAULT ''::text NOT NULL,
    target_agent_instance_id text DEFAULT ''::text NOT NULL,
    work_scope_id text DEFAULT ''::text NOT NULL,
    memory_document_version_id text DEFAULT ''::text NOT NULL,
    requested_reason text DEFAULT ''::text NOT NULL,
    requester_role_snapshot text DEFAULT ''::text NOT NULL,
    leadership_assignment_snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    result text NOT NULL,
    result_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_work_memory_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_work_memory_versions (
    id text NOT NULL,
    work_scope_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_instance_id text NOT NULL,
    memory_document_id text NOT NULL,
    memory_document_version_id text NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    visibility text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    source_cursor text DEFAULT ''::text NOT NULL,
    encryption_algorithm text NOT NULL,
    encryption_key_version integer DEFAULT 1 NOT NULL,
    content_ciphertext text NOT NULL,
    content_nonce text NOT NULL,
    content_tag text NOT NULL,
    content_aad text DEFAULT ''::text NOT NULL,
    cloud_wrap_algorithm text NOT NULL,
    cloud_wrapping_key_id text NOT NULL,
    cloud_wrapped_key text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_work_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_work_participants (
    work_scope_id text NOT NULL,
    user_id text NOT NULL,
    agent_instance_id text NOT NULL,
    agent_family_id text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'executor'::text NOT NULL,
    collaboration_edges_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_work_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_work_scopes (
    id text NOT NULL,
    federation_type text NOT NULL,
    federation_id text NOT NULL,
    owner_user_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    revision_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collaboration_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_files (
    id text NOT NULL,
    delegation_id text NOT NULL,
    group_id text,
    owner_user_id text NOT NULL,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    sha256 text DEFAULT ''::text NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collaboration_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_group_members (
    group_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    last_read_at timestamp with time zone,
    display_name_override text DEFAULT ''::text NOT NULL
);


--
-- Name: collaboration_group_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_group_messages (
    id text NOT NULL,
    group_id text NOT NULL,
    sender_user_id text NOT NULL,
    sender_agent_id text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'friend'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_event_id text DEFAULT ''::text NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);


--
-- Name: collaboration_group_workspace_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_group_workspace_files (
    id text NOT NULL,
    group_id text NOT NULL,
    relative_path text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    owner_user_id text NOT NULL,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    sha256 text DEFAULT ''::text NOT NULL,
    data bytea DEFAULT '\x'::bytea NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collaboration_group_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_group_workspaces (
    group_id text NOT NULL,
    workspace_epoch text DEFAULT ''::text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collaboration_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collaboration_groups (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    title text DEFAULT 'uBuddy 任务群'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    client_request_id text DEFAULT ''::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);


--
-- Name: contact_organization_exit_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_organization_exit_requests (
    id text NOT NULL,
    organization_id text NOT NULL,
    requester_user_id text NOT NULL,
    requester_role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: contact_organization_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_organization_members (
    organization_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name_override text DEFAULT ''::text NOT NULL
);


--
-- Name: contact_organization_notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_organization_notices (
    id text NOT NULL,
    user_id text NOT NULL,
    organization_id text,
    organization_name text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_organizations (
    id text NOT NULL,
    organization_number text NOT NULL,
    name text NOT NULL,
    verification_code_salt text NOT NULL,
    verification_code_hash text NOT NULL,
    owner_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verifications (
    id text NOT NULL,
    email text NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: friend_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friend_requests (
    id text NOT NULL,
    requester_id text NOT NULL,
    recipient_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    id text NOT NULL,
    user_a_id text NOT NULL,
    user_b_id text NOT NULL,
    user_a_remark text DEFAULT ''::text NOT NULL,
    user_b_remark text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: large_file_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.large_file_objects (
    id text NOT NULL,
    account_workspace_id text NOT NULL,
    owner_user_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id text NOT NULL,
    recipient_user_id text,
    group_id text,
    delegation_id text,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    storage_key text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT large_file_objects_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['social'::text, 'chat_group'::text, 'collaboration_group'::text, 'collaboration_task'::text]))),
    CONSTRAINT large_file_objects_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT large_file_objects_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'unavailable'::text])))
);


--
-- Name: large_file_upload_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.large_file_upload_chunks (
    upload_id text NOT NULL,
    chunk_index integer NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT large_file_upload_chunks_chunk_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT large_file_upload_chunks_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: large_file_upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.large_file_upload_sessions (
    id text NOT NULL,
    file_id text NOT NULL,
    account_workspace_id text NOT NULL,
    owner_user_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id text NOT NULL,
    recipient_user_id text,
    group_id text,
    delegation_id text,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    chunk_size_bytes integer NOT NULL,
    chunk_count integer NOT NULL,
    storage_key text NOT NULL,
    status text DEFAULT 'uploading'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT large_file_upload_sessions_chunk_count_check CHECK ((chunk_count > 0)),
    CONSTRAINT large_file_upload_sessions_chunk_size_bytes_check CHECK ((chunk_size_bytes > 0)),
    CONSTRAINT large_file_upload_sessions_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['social'::text, 'chat_group'::text, 'collaboration_group'::text, 'collaboration_task'::text]))),
    CONSTRAINT large_file_upload_sessions_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT large_file_upload_sessions_status_check CHECK ((status = ANY (ARRAY['uploading'::text, 'assembling'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: social_contact_remarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_contact_remarks (
    owner_user_id text NOT NULL,
    target_user_id text NOT NULL,
    remark text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_contact_remarks_check CHECK ((owner_user_id <> target_user_id))
);


--
-- Name: social_conversation_preference_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_conversation_preference_commands (
    command_id text NOT NULL,
    account_workspace_id text NOT NULL,
    user_id text NOT NULL,
    conversation_kind text NOT NULL,
    conversation_id text NOT NULL,
    request_payload_hash text NOT NULL,
    response_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_conversation_preference_commands_conversation_kind_check CHECK ((conversation_kind = ANY (ARRAY['chat_group'::text, 'collaboration_group'::text])))
);


--
-- Name: social_conversation_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_conversation_preferences (
    account_workspace_id text NOT NULL,
    user_id text NOT NULL,
    conversation_kind text NOT NULL,
    conversation_id text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    last_command_id text DEFAULT ''::text NOT NULL,
    source_device_id text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_conversation_preferences_conversation_kind_check CHECK ((conversation_kind = ANY (ARRAY['chat_group'::text, 'collaboration_group'::text]))),
    CONSTRAINT social_conversation_preferences_state_revision_check CHECK ((state_revision >= 1))
);


--
-- Name: social_message_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_message_files (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    recipient_user_id text,
    group_id text,
    filename text DEFAULT 'file'::text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    sha256 text DEFAULT ''::text NOT NULL,
    data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL,
    CONSTRAINT social_message_files_check CHECK ((((recipient_user_id IS NOT NULL) AND (group_id IS NULL)) OR ((recipient_user_id IS NULL) AND (group_id IS NOT NULL))))
);


--
-- Name: social_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_messages (
    id text NOT NULL,
    sender_user_id text NOT NULL,
    recipient_user_id text NOT NULL,
    sender_agent_id text DEFAULT ''::text NOT NULL,
    recipient_agent_id text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'friend'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'unread'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);


--
-- Name: social_realtime_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_realtime_events (
    sequence_id bigint NOT NULL,
    id text NOT NULL,
    account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL,
    recipient_user_id text NOT NULL,
    event_type text NOT NULL,
    aggregate_type text DEFAULT 'agent_delegation'::text NOT NULL,
    aggregate_id text NOT NULL,
    aggregate_version bigint DEFAULT 0 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: social_realtime_events_sequence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.social_realtime_events_sequence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: social_realtime_events_sequence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.social_realtime_events_sequence_id_seq OWNED BY public.social_realtime_events.sequence_id;


--
-- Name: social_ubuddy_capability_profile_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_ubuddy_capability_profile_commands (
    command_id text NOT NULL,
    owner_user_id text NOT NULL,
    operation_kind text NOT NULL,
    payload_hash text NOT NULL,
    response_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_ubuddy_capability_profile_commands_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['publish'::text, 'unpublish'::text])))
);


--
-- Name: social_ubuddy_capability_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_ubuddy_capability_profiles (
    owner_user_id text NOT NULL,
    ubuddy_agent_instance_id text NOT NULL,
    profile_revision bigint NOT NULL,
    profile_version text DEFAULT 'ubuddy_capability_profile_v1'::text NOT NULL,
    visibility text NOT NULL,
    publication_state text DEFAULT 'active'::text NOT NULL,
    source_effective_skill_hash text NOT NULL,
    content_hash text NOT NULL,
    profile_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    last_command_id text DEFAULT ''::text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_ubuddy_capability_profiles_profile_revision_check CHECK ((profile_revision >= 1)),
    CONSTRAINT social_ubuddy_capability_profiles_publication_state_check CHECK ((publication_state = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT social_ubuddy_capability_profiles_state_revision_check CHECK ((state_revision >= 1)),
    CONSTRAINT social_ubuddy_capability_profiles_visibility_check CHECK ((visibility = ANY (ARRAY['friends'::text, 'organization'::text])))
);


--
-- Name: task_node_result_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_node_result_versions (
    id text NOT NULL,
    task_run_id text NOT NULL,
    task_node_id text NOT NULL,
    graph_revision_id text DEFAULT ''::text NOT NULL,
    version_no integer DEFAULT 1 NOT NULL,
    result_text text DEFAULT ''::text NOT NULL,
    result_summary text DEFAULT ''::text NOT NULL,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    decision text DEFAULT 'pending'::text NOT NULL,
    decision_reason text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT task_node_result_versions_decision_check CHECK ((decision = ANY (ARRAY['pending'::text, 'adopted'::text, 'superseded'::text, 'rejected'::text])))
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    id text NOT NULL,
    blocker_id text NOT NULL,
    blocked_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_presence (
    user_id text NOT NULL,
    device_id text NOT NULL,
    platform text DEFAULT ''::text NOT NULL,
    arch text DEFAULT ''::text NOT NULL,
    hostname text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'online'::text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    username text,
    avatar_url text DEFAULT ''::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_sync_changes_v6 sequence_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v6 ALTER COLUMN sequence_id SET DEFAULT nextval('public.cloud_sync_changes_v6_sequence_id_seq'::regclass);


--
-- Name: cloud_sync_changes_v8 sequence_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8 ALTER COLUMN sequence_id SET DEFAULT nextval('public.cloud_sync_changes_v8_sequence_id_seq'::regclass);


--
-- Name: social_realtime_events sequence_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_realtime_events ALTER COLUMN sequence_id SET DEFAULT nextval('public.social_realtime_events_sequence_id_seq'::regclass);


--
-- Name: account_memberships_v8 account_memberships_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_memberships_v8
    ADD CONSTRAINT account_memberships_v8_pkey PRIMARY KEY (account_id, user_id);


--
-- Name: account_workspace_bindings_v8 account_workspace_bindings_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_bindings_v8
    ADD CONSTRAINT account_workspace_bindings_v8_pkey PRIMARY KEY (account_id, workspace_id, user_id_scope);


--
-- Name: account_workspace_bindings_v8 account_workspace_bindings_v8_workspace_id_user_id_scope_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_bindings_v8
    ADD CONSTRAINT account_workspace_bindings_v8_workspace_id_user_id_scope_key UNIQUE (workspace_id, user_id_scope);


--
-- Name: account_workspace_memberships account_workspace_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_memberships
    ADD CONSTRAINT account_workspace_memberships_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: account_workspaces account_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspaces
    ADD CONSTRAINT account_workspaces_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: agent_delegation_execution_leases agent_delegation_execution_leases_lease_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_execution_leases
    ADD CONSTRAINT agent_delegation_execution_leases_lease_token_key UNIQUE (lease_token);


--
-- Name: agent_delegation_execution_leases agent_delegation_execution_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_execution_leases
    ADD CONSTRAINT agent_delegation_execution_leases_pkey PRIMARY KEY (delegation_id);


--
-- Name: agent_delegation_revisions agent_delegation_revisions_delegation_id_revision_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_revisions
    ADD CONSTRAINT agent_delegation_revisions_delegation_id_revision_no_key UNIQUE (delegation_id, revision_no);


--
-- Name: agent_delegation_revisions agent_delegation_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_revisions
    ADD CONSTRAINT agent_delegation_revisions_pkey PRIMARY KEY (id);


--
-- Name: agent_delegation_workspace_messages agent_delegation_workspace_message_delegation_id_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspace_messages
    ADD CONSTRAINT agent_delegation_workspace_message_delegation_id_user_id_id_key UNIQUE (delegation_id, user_id, id);


--
-- Name: agent_delegation_workspace_messages agent_delegation_workspace_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspace_messages
    ADD CONSTRAINT agent_delegation_workspace_messages_pkey PRIMARY KEY (id);


--
-- Name: agent_delegation_workspaces agent_delegation_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspaces
    ADD CONSTRAINT agent_delegation_workspaces_pkey PRIMARY KEY (delegation_id, user_id);


--
-- Name: agent_delegations agent_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_pkey PRIMARY KEY (id);


--
-- Name: chat_group_members chat_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: chat_group_message_files chat_group_message_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_message_files
    ADD CONSTRAINT chat_group_message_files_pkey PRIMARY KEY (id);


--
-- Name: chat_group_messages chat_group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_messages
    ADD CONSTRAINT chat_group_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_group_operations chat_group_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_operations
    ADD CONSTRAINT chat_group_operations_pkey PRIMARY KEY (idempotency_key);


--
-- Name: chat_groups chat_groups_account_workspace_id_owner_user_id_client_reque_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_account_workspace_id_owner_user_id_client_reque_key UNIQUE (account_workspace_id, owner_user_id, client_request_id);


--
-- Name: chat_groups chat_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_pkey PRIMARY KEY (id);


--
-- Name: chat_sessions chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_cohort_members cloud_agent_cohort_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_cohort_members
    ADD CONSTRAINT cloud_agent_cohort_members_pkey PRIMARY KEY (cohort_id, user_agent_instance_id);


--
-- Name: cloud_agent_cohorts cloud_agent_cohorts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_cohorts
    ADD CONSTRAINT cloud_agent_cohorts_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_context_spaces cloud_agent_context_spaces_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_spaces
    ADD CONSTRAINT cloud_agent_context_spaces_pkey1 PRIMARY KEY (user_id, id);


--
-- Name: cloud_agent_context_states cloud_agent_context_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_states
    ADD CONSTRAINT cloud_agent_context_states_pkey PRIMARY KEY (owner_user_id, user_agent_instance_id);


--
-- Name: cloud_agent_families_v3 cloud_agent_families_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_families_v3
    ADD CONSTRAINT cloud_agent_families_v3_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_instance_alias_repairs cloud_agent_instance_alias_repairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_instance_alias_repairs
    ADD CONSTRAINT cloud_agent_instance_alias_repairs_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_leadership_evaluations cloud_agent_leadership_evalua_user_agent_instance_id_task_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_evaluations
    ADD CONSTRAINT cloud_agent_leadership_evalua_user_agent_instance_id_task_i_key UNIQUE (user_agent_instance_id, task_id, assignment_id, algorithm_version);


--
-- Name: cloud_agent_leadership_evaluations cloud_agent_leadership_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_evaluations
    ADD CONSTRAINT cloud_agent_leadership_evaluations_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_leadership_events cloud_agent_leadership_events_owner_user_id_user_agent_inst_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_events
    ADD CONSTRAINT cloud_agent_leadership_events_owner_user_id_user_agent_inst_key UNIQUE (owner_user_id, user_agent_instance_id, task_id, assignment_id, event_kind, occurred_at);


--
-- Name: cloud_agent_leadership_events cloud_agent_leadership_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_events
    ADD CONSTRAINT cloud_agent_leadership_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_leadership_history cloud_agent_leadership_histor_user_agent_instance_id_algori_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_history
    ADD CONSTRAINT cloud_agent_leadership_histor_user_agent_instance_id_algori_key UNIQUE (user_agent_instance_id, algorithm_version, input_hash);


--
-- Name: cloud_agent_leadership_history cloud_agent_leadership_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_history
    ADD CONSTRAINT cloud_agent_leadership_history_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_leadership_levels cloud_agent_leadership_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_levels
    ADD CONSTRAINT cloud_agent_leadership_levels_pkey PRIMARY KEY (user_agent_instance_id);


--
-- Name: cloud_agent_performance_events cloud_agent_performance_event_owner_user_id_user_agent_inst_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_events
    ADD CONSTRAINT cloud_agent_performance_event_owner_user_id_user_agent_inst_key UNIQUE (owner_user_id, user_agent_instance_id, task_id, event_kind, occurred_at);


--
-- Name: cloud_agent_performance_events cloud_agent_performance_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_events
    ADD CONSTRAINT cloud_agent_performance_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_performance_history cloud_agent_performance_histo_user_agent_instance_id_algori_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_history
    ADD CONSTRAINT cloud_agent_performance_histo_user_agent_instance_id_algori_key UNIQUE (user_agent_instance_id, algorithm_version, input_hash);


--
-- Name: cloud_agent_performance_history cloud_agent_performance_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_history
    ADD CONSTRAINT cloud_agent_performance_history_pkey PRIMARY KEY (id);


--
-- Name: cloud_agent_performance_levels cloud_agent_performance_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_levels
    ADD CONSTRAINT cloud_agent_performance_levels_pkey PRIMARY KEY (user_agent_instance_id);


--
-- Name: cloud_agent_versions_v3 cloud_agent_versions_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_versions_v3
    ADD CONSTRAINT cloud_agent_versions_v3_pkey PRIMARY KEY (id);


--
-- Name: cloud_chat_context_states cloud_chat_context_states_owner_user_id_session_id_context__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_chat_context_states
    ADD CONSTRAINT cloud_chat_context_states_owner_user_id_session_id_context__key UNIQUE (owner_user_id, session_id, context_space_id);


--
-- Name: cloud_chat_context_states cloud_chat_context_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_chat_context_states
    ADD CONSTRAINT cloud_chat_context_states_pkey PRIMARY KEY (id);


--
-- Name: cloud_cluster_evidence_claims cloud_cluster_evidence_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_cluster_evidence_claims
    ADD CONSTRAINT cloud_cluster_evidence_claims_pkey PRIMARY KEY (evidence_id);


--
-- Name: cloud_cluster_run_evidence cloud_cluster_run_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_cluster_run_evidence
    ADD CONSTRAINT cloud_cluster_run_evidence_pkey PRIMARY KEY (run_id, evidence_id);


--
-- Name: cloud_conversation_aliases_v7 cloud_conversation_aliases_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_conversation_aliases_v7
    ADD CONSTRAINT cloud_conversation_aliases_v7_pkey PRIMARY KEY (user_id, alias_conversation_id);


--
-- Name: cloud_conversations_v6 cloud_conversations_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_conversations_v6
    ADD CONSTRAINT cloud_conversations_v6_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_device_token_nonces_v6 cloud_device_token_nonces_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_device_token_nonces_v6
    ADD CONSTRAINT cloud_device_token_nonces_v6_pkey PRIMARY KEY (user_id, device_id, nonce);


--
-- Name: cloud_devices_v6 cloud_devices_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_devices_v6
    ADD CONSTRAINT cloud_devices_v6_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: cloud_effective_skill_projections cloud_effective_skill_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_effective_skill_projections
    ADD CONSTRAINT cloud_effective_skill_projections_pkey PRIMARY KEY (user_id, user_agent_instance_id);


--
-- Name: cloud_employee_roster_states cloud_employee_roster_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_employee_roster_states
    ADD CONSTRAINT cloud_employee_roster_states_pkey PRIMARY KEY (user_id);


--
-- Name: cloud_evolution_apply_journals cloud_evolution_apply_journals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_apply_journals
    ADD CONSTRAINT cloud_evolution_apply_journals_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_collection_boundaries cloud_evolution_collection_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_collection_boundaries
    ADD CONSTRAINT cloud_evolution_collection_boundaries_pkey PRIMARY KEY (source_kind);


--
-- Name: cloud_evolution_evaluations cloud_evolution_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evaluations
    ADD CONSTRAINT cloud_evolution_evaluations_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_evaluations cloud_evolution_evaluations_run_id_evaluation_kind_case_ind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evaluations
    ADD CONSTRAINT cloud_evolution_evaluations_run_id_evaluation_kind_case_ind_key UNIQUE (run_id, evaluation_kind, case_index);


--
-- Name: cloud_evolution_evidence_access_audits cloud_evolution_evidence_access_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_access_audits
    ADD CONSTRAINT cloud_evolution_evidence_access_audits_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_evidence cloud_evolution_evidence_owner_user_id_user_agent_instance__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence
    ADD CONSTRAINT cloud_evolution_evidence_owner_user_id_user_agent_instance__key UNIQUE (owner_user_id, user_agent_instance_id, source_kind, source_id, source_version_id, content_hash);


--
-- Name: cloud_evolution_evidence cloud_evolution_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence
    ADD CONSTRAINT cloud_evolution_evidence_pkey PRIMARY KEY (evidence_id);


--
-- Name: cloud_evolution_evidence_quarantine cloud_evolution_evidence_quarantine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_quarantine
    ADD CONSTRAINT cloud_evolution_evidence_quarantine_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_evidence_usage_events cloud_evolution_evidence_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_usage_events
    ADD CONSTRAINT cloud_evolution_evidence_usage_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_evidence_usage cloud_evolution_evidence_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_usage
    ADD CONSTRAINT cloud_evolution_evidence_usage_pkey PRIMARY KEY (evidence_id, evolution_scope, consumer_id);


--
-- Name: cloud_evolution_evidence_validation_jobs cloud_evolution_evidence_validation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_validation_jobs
    ADD CONSTRAINT cloud_evolution_evidence_validation_jobs_pkey PRIMARY KEY (evidence_id);


--
-- Name: cloud_evolution_jobs cloud_evolution_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_jobs
    ADD CONSTRAINT cloud_evolution_jobs_pkey PRIMARY KEY (id);


--
-- Name: cloud_evolution_jobs cloud_evolution_jobs_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_jobs
    ADD CONSTRAINT cloud_evolution_jobs_run_id_key UNIQUE (run_id);


--
-- Name: cloud_evolution_key_rotation_jobs cloud_evolution_key_rotation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_key_rotation_jobs
    ADD CONSTRAINT cloud_evolution_key_rotation_jobs_pkey PRIMARY KEY (evidence_id, target_key_id);


--
-- Name: cloud_evolution_run_snapshots cloud_evolution_run_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_run_snapshots
    ADD CONSTRAINT cloud_evolution_run_snapshots_pkey PRIMARY KEY (run_id);


--
-- Name: cloud_evolution_runs cloud_evolution_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_runs
    ADD CONSTRAINT cloud_evolution_runs_pkey PRIMARY KEY (id);


--
-- Name: cloud_file_objects_v6 cloud_file_objects_v6_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_file_objects_v6
    ADD CONSTRAINT cloud_file_objects_v6_object_key_key UNIQUE (object_key);


--
-- Name: cloud_file_objects_v6 cloud_file_objects_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_file_objects_v6
    ADD CONSTRAINT cloud_file_objects_v6_pkey PRIMARY KEY (user_id, sha256);


--
-- Name: cloud_file_refs_v6 cloud_file_refs_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_file_refs_v6
    ADD CONSTRAINT cloud_file_refs_v6_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_leadership_appeals cloud_leadership_appeals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_appeals
    ADD CONSTRAINT cloud_leadership_appeals_pkey PRIMARY KEY (id);


--
-- Name: cloud_leadership_assignments cloud_leadership_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_assignments
    ADD CONSTRAINT cloud_leadership_assignments_pkey PRIMARY KEY (id);


--
-- Name: cloud_leadership_promotion_actions cloud_leadership_promotion_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_promotion_actions
    ADD CONSTRAINT cloud_leadership_promotion_actions_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_adoption_actions cloud_market_adoption_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_adoption_actions
    ADD CONSTRAINT cloud_market_adoption_actions_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_agent_candidates cloud_market_agent_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_agent_candidates
    ADD CONSTRAINT cloud_market_agent_candidates_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_agent_versions cloud_market_agent_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_agent_versions
    ADD CONSTRAINT cloud_market_agent_versions_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_canary_assignments cloud_market_canary_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_assignments
    ADD CONSTRAINT cloud_market_canary_assignments_pkey PRIMARY KEY (candidate_id, user_agent_instance_id);


--
-- Name: cloud_market_canary_evaluations cloud_market_canary_evaluations_candidate_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_evaluations
    ADD CONSTRAINT cloud_market_canary_evaluations_candidate_id_key UNIQUE (candidate_id);


--
-- Name: cloud_market_canary_evaluations cloud_market_canary_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_evaluations
    ADD CONSTRAINT cloud_market_canary_evaluations_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_canary_opt_ins cloud_market_canary_opt_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_opt_ins
    ADD CONSTRAINT cloud_market_canary_opt_ins_pkey PRIMARY KEY (user_id, user_agent_instance_id);


--
-- Name: cloud_market_candidate_family_sections cloud_market_candidate_family_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_family_sections
    ADD CONSTRAINT cloud_market_candidate_family_sections_pkey PRIMARY KEY (candidate_id, agent_family_id, section_id);


--
-- Name: cloud_market_candidate_privacy_reviews cloud_market_candidate_privac_candidate_id_agent_family_id__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_privacy_reviews
    ADD CONSTRAINT cloud_market_candidate_privac_candidate_id_agent_family_id__key UNIQUE (candidate_id, agent_family_id, review_stage);


--
-- Name: cloud_market_candidate_privacy_reviews cloud_market_candidate_privacy_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_privacy_reviews
    ADD CONSTRAINT cloud_market_candidate_privacy_reviews_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_candidate_section_supports cloud_market_candidate_section_supports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_section_supports
    ADD CONSTRAINT cloud_market_candidate_section_supports_pkey PRIMARY KEY (candidate_id, agent_family_id, section_id, evidence_id);


--
-- Name: cloud_market_candidate_sections cloud_market_candidate_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_sections
    ADD CONSTRAINT cloud_market_candidate_sections_pkey PRIMARY KEY (candidate_id, section_id);


--
-- Name: cloud_market_evaluations cloud_market_evaluations_candidate_id_evaluation_kind_case__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_evaluations
    ADD CONSTRAINT cloud_market_evaluations_candidate_id_evaluation_kind_case__key UNIQUE (candidate_id, evaluation_kind, case_index);


--
-- Name: cloud_market_evaluations cloud_market_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_evaluations
    ADD CONSTRAINT cloud_market_evaluations_pkey PRIMARY KEY (id);


--
-- Name: cloud_market_version_health cloud_market_version_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_version_health
    ADD CONSTRAINT cloud_market_version_health_pkey PRIMARY KEY (market_version_id);


--
-- Name: cloud_market_version_sections cloud_market_version_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_version_sections
    ADD CONSTRAINT cloud_market_version_sections_pkey PRIMARY KEY (market_version_id, section_id);


--
-- Name: cloud_memory_access_audits cloud_memory_access_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_access_audits
    ADD CONSTRAINT cloud_memory_access_audits_pkey PRIMARY KEY (id);


--
-- Name: cloud_memory_document_aliases_v3 cloud_memory_document_aliases_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_aliases_v3
    ADD CONSTRAINT cloud_memory_document_aliases_v3_pkey PRIMARY KEY (user_id, alias_document_id);


--
-- Name: cloud_memory_document_versions_v3 cloud_memory_document_version_user_id_memory_document_id_ve_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_versions_v3
    ADD CONSTRAINT cloud_memory_document_version_user_id_memory_document_id_ve_key UNIQUE (user_id, memory_document_id, version_no);


--
-- Name: cloud_memory_document_versions_v3 cloud_memory_document_versions_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_versions_v3
    ADD CONSTRAINT cloud_memory_document_versions_v3_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_memory_documents_v3 cloud_memory_documents_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_documents_v3
    ADD CONSTRAINT cloud_memory_documents_v3_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_memory_sync_mappings cloud_memory_sync_mappings_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_sync_mappings
    ADD CONSTRAINT cloud_memory_sync_mappings_pkey1 PRIMARY KEY (owner_user_id, user_agent_instance_id, cloud_key);


--
-- Name: cloud_messages_v6 cloud_messages_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_messages_v6
    ADD CONSTRAINT cloud_messages_v6_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_model_executions_v6 cloud_model_executions_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_model_executions_v6
    ADD CONSTRAINT cloud_model_executions_v6_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_performance_backfill_cursors cloud_performance_backfill_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_performance_backfill_cursors
    ADD CONSTRAINT cloud_performance_backfill_cursors_pkey PRIMARY KEY (cursor_key);


--
-- Name: cloud_personal_evolution_actions_v4 cloud_personal_evolution_acti_user_id_proposal_id_target_ki_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_actions_v4
    ADD CONSTRAINT cloud_personal_evolution_acti_user_id_proposal_id_target_ki_key UNIQUE (user_id, proposal_id, target_kind, target_id);


--
-- Name: cloud_personal_evolution_actions_v4 cloud_personal_evolution_actions_v4_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_actions_v4
    ADD CONSTRAINT cloud_personal_evolution_actions_v4_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_personal_evolution_memory_operations_v4 cloud_personal_evolution_memory_operations_v4_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_memory_operations_v4
    ADD CONSTRAINT cloud_personal_evolution_memory_operations_v4_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_personal_evolution_proposals_v4 cloud_personal_evolution_proposals_v4_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_proposals_v4
    ADD CONSTRAINT cloud_personal_evolution_proposals_v4_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_personal_evolution_schedule_states cloud_personal_evolution_schedule_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_schedule_states
    ADD CONSTRAINT cloud_personal_evolution_schedule_states_pkey PRIMARY KEY (user_agent_instance_id);


--
-- Name: cloud_personal_skill_overlay_versions cloud_personal_skill_overlay_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_skill_overlay_versions
    ADD CONSTRAINT cloud_personal_skill_overlay_versions_pkey PRIMARY KEY (id);


--
-- Name: cloud_personal_version_commands cloud_personal_version_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_version_commands
    ADD CONSTRAINT cloud_personal_version_commands_pkey PRIMARY KEY (user_id, command_id);


--
-- Name: cloud_personal_version_health cloud_personal_version_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_version_health
    ADD CONSTRAINT cloud_personal_version_health_pkey PRIMARY KEY (personal_skill_version_id);


--
-- Name: cloud_projects_v6 cloud_projects_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_projects_v6
    ADD CONSTRAINT cloud_projects_v6_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_sync_batches_v6 cloud_sync_batches_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v6
    ADD CONSTRAINT cloud_sync_batches_v6_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_batches_v6 cloud_sync_batches_v6_user_id_device_id_payload_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v6
    ADD CONSTRAINT cloud_sync_batches_v6_user_id_device_id_payload_hash_key UNIQUE (user_id, device_id, payload_hash);


--
-- Name: cloud_sync_batches_v8 cloud_sync_batches_v8_account_id_user_id_device_id_payload__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v8
    ADD CONSTRAINT cloud_sync_batches_v8_account_id_user_id_device_id_payload__key UNIQUE (account_id, user_id, device_id, payload_hash);


--
-- Name: cloud_sync_batches_v8 cloud_sync_batches_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v8
    ADD CONSTRAINT cloud_sync_batches_v8_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_changes_v6 cloud_sync_changes_v6_change_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v6
    ADD CONSTRAINT cloud_sync_changes_v6_change_id_key UNIQUE (change_id);


--
-- Name: cloud_sync_changes_v6 cloud_sync_changes_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v6
    ADD CONSTRAINT cloud_sync_changes_v6_pkey PRIMARY KEY (sequence_id);


--
-- Name: cloud_sync_changes_v8 cloud_sync_changes_v8_change_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8
    ADD CONSTRAINT cloud_sync_changes_v8_change_id_key UNIQUE (change_id);


--
-- Name: cloud_sync_changes_v8 cloud_sync_changes_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8
    ADD CONSTRAINT cloud_sync_changes_v8_pkey PRIMARY KEY (sequence_id);


--
-- Name: cloud_sync_compaction_states_v7 cloud_sync_compaction_states_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_compaction_states_v7
    ADD CONSTRAINT cloud_sync_compaction_states_v7_pkey PRIMARY KEY (user_id);


--
-- Name: cloud_sync_compaction_states_v8 cloud_sync_compaction_states_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_compaction_states_v8
    ADD CONSTRAINT cloud_sync_compaction_states_v8_pkey PRIMARY KEY (account_id);


--
-- Name: cloud_sync_conflicts_v6 cloud_sync_conflicts_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v6
    ADD CONSTRAINT cloud_sync_conflicts_v6_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_conflicts_v8 cloud_sync_conflicts_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v8
    ADD CONSTRAINT cloud_sync_conflicts_v8_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_device_cursors_v7 cloud_sync_device_cursors_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_device_cursors_v7
    ADD CONSTRAINT cloud_sync_device_cursors_v7_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: cloud_sync_device_cursors_v8 cloud_sync_device_cursors_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_device_cursors_v8
    ADD CONSTRAINT cloud_sync_device_cursors_v8_pkey PRIMARY KEY (account_id, user_id, device_id);


--
-- Name: cloud_sync_entities_v6 cloud_sync_entities_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_entities_v6
    ADD CONSTRAINT cloud_sync_entities_v6_pkey PRIMARY KEY (user_id, entity_type, entity_id);


--
-- Name: cloud_sync_entities_v8 cloud_sync_entities_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_entities_v8
    ADD CONSTRAINT cloud_sync_entities_v8_pkey PRIMARY KEY (account_id, entity_type, entity_id);


--
-- Name: cloud_sync_grants cloud_sync_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_grants
    ADD CONSTRAINT cloud_sync_grants_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_grants cloud_sync_grants_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_grants
    ADD CONSTRAINT cloud_sync_grants_token_hash_key UNIQUE (token_hash);


--
-- Name: cloud_sync_grants cloud_sync_grants_user_id_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_grants
    ADD CONSTRAINT cloud_sync_grants_user_id_device_id_key UNIQUE (user_id, device_id);


--
-- Name: cloud_sync_history_repairs cloud_sync_history_repairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_history_repairs
    ADD CONSTRAINT cloud_sync_history_repairs_pkey PRIMARY KEY (id);


--
-- Name: cloud_sync_history_repairs cloud_sync_history_repairs_user_id_repair_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_history_repairs
    ADD CONSTRAINT cloud_sync_history_repairs_user_id_repair_kind_key UNIQUE (user_id, repair_kind);


--
-- Name: cloud_sync_rate_limits_v7 cloud_sync_rate_limits_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_rate_limits_v7
    ADD CONSTRAINT cloud_sync_rate_limits_v7_pkey PRIMARY KEY (user_id, device_id, operation);


--
-- Name: cloud_sync_snapshots_v7 cloud_sync_snapshots_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_snapshots_v7
    ADD CONSTRAINT cloud_sync_snapshots_v7_pkey PRIMARY KEY (user_id);


--
-- Name: cloud_sync_snapshots_v8 cloud_sync_snapshots_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_snapshots_v8
    ADD CONSTRAINT cloud_sync_snapshots_v8_pkey PRIMARY KEY (account_id);


--
-- Name: cloud_sync_usage_v7 cloud_sync_usage_v7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_usage_v7
    ADD CONSTRAINT cloud_sync_usage_v7_pkey PRIMARY KEY (user_id);


--
-- Name: cloud_sync_usage_v8 cloud_sync_usage_v8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_usage_v8
    ADD CONSTRAINT cloud_sync_usage_v8_pkey PRIMARY KEY (account_id);


--
-- Name: cloud_task_events cloud_task_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_events
    ADD CONSTRAINT cloud_task_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_task_key_access_audits_v6 cloud_task_key_access_audits_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_key_access_audits_v6
    ADD CONSTRAINT cloud_task_key_access_audits_v6_pkey PRIMARY KEY (id);


--
-- Name: cloud_task_key_device_envelopes_v6 cloud_task_key_device_envelopes_v6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_key_device_envelopes_v6
    ADD CONSTRAINT cloud_task_key_device_envelopes_v6_pkey PRIMARY KEY (user_id, task_run_id, key_version, device_id);


--
-- Name: cloud_task_nodes cloud_task_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_nodes
    ADD CONSTRAINT cloud_task_nodes_pkey PRIMARY KEY (id);


--
-- Name: cloud_task_runs cloud_task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_runs
    ADD CONSTRAINT cloud_task_runs_pkey PRIMARY KEY (id);


--
-- Name: cloud_task_security_contexts_v5 cloud_task_security_contexts_v5_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_security_contexts_v5
    ADD CONSTRAINT cloud_task_security_contexts_v5_pkey PRIMARY KEY (user_id, task_run_id);


--
-- Name: cloud_user_agent_instance_aliases_v3 cloud_user_agent_instance_aliases_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_instance_aliases_v3
    ADD CONSTRAINT cloud_user_agent_instance_aliases_v3_pkey PRIMARY KEY (user_id, alias_instance_id);


--
-- Name: cloud_user_agent_instances_v3 cloud_user_agent_instances_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_instances_v3
    ADD CONSTRAINT cloud_user_agent_instances_v3_pkey PRIMARY KEY (user_id, id);


--
-- Name: cloud_user_agent_recruitment_events cloud_user_agent_recruitment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_recruitment_events
    ADD CONSTRAINT cloud_user_agent_recruitment_events_pkey PRIMARY KEY (id);


--
-- Name: cloud_user_agent_recruitment_events cloud_user_agent_recruitment_events_user_id_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_recruitment_events
    ADD CONSTRAINT cloud_user_agent_recruitment_events_user_id_command_id_key UNIQUE (user_id, command_id);


--
-- Name: cloud_user_evolution_preferences cloud_user_evolution_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_evolution_preferences
    ADD CONSTRAINT cloud_user_evolution_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: cloud_user_market_adoptions cloud_user_market_adoptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_market_adoptions
    ADD CONSTRAINT cloud_user_market_adoptions_pkey PRIMARY KEY (user_id, user_agent_instance_id, market_version_id, section_id);


--
-- Name: cloud_work_memory_access_audits cloud_work_memory_access_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_access_audits
    ADD CONSTRAINT cloud_work_memory_access_audits_pkey PRIMARY KEY (id);


--
-- Name: cloud_work_memory_versions cloud_work_memory_versions_owner_user_id_memory_document_ve_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_versions
    ADD CONSTRAINT cloud_work_memory_versions_owner_user_id_memory_document_ve_key UNIQUE (owner_user_id, memory_document_version_id);


--
-- Name: cloud_work_memory_versions cloud_work_memory_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_versions
    ADD CONSTRAINT cloud_work_memory_versions_pkey PRIMARY KEY (id);


--
-- Name: cloud_work_participants cloud_work_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_participants
    ADD CONSTRAINT cloud_work_participants_pkey PRIMARY KEY (work_scope_id, user_id, agent_instance_id);


--
-- Name: cloud_work_scopes cloud_work_scopes_federation_type_federation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_scopes
    ADD CONSTRAINT cloud_work_scopes_federation_type_federation_id_key UNIQUE (federation_type, federation_id);


--
-- Name: cloud_work_scopes cloud_work_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_scopes
    ADD CONSTRAINT cloud_work_scopes_pkey PRIMARY KEY (id);


--
-- Name: collaboration_files collaboration_files_delegation_id_owner_user_id_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_files
    ADD CONSTRAINT collaboration_files_delegation_id_owner_user_id_sha256_key UNIQUE (delegation_id, owner_user_id, sha256);


--
-- Name: collaboration_files collaboration_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_files
    ADD CONSTRAINT collaboration_files_pkey PRIMARY KEY (id);


--
-- Name: collaboration_group_members collaboration_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: collaboration_group_messages collaboration_group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_messages
    ADD CONSTRAINT collaboration_group_messages_pkey PRIMARY KEY (id);


--
-- Name: collaboration_group_workspace_files collaboration_group_workspace_files_group_id_relative_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspace_files
    ADD CONSTRAINT collaboration_group_workspace_files_group_id_relative_path_key UNIQUE (group_id, relative_path);


--
-- Name: collaboration_group_workspace_files collaboration_group_workspace_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspace_files
    ADD CONSTRAINT collaboration_group_workspace_files_pkey PRIMARY KEY (id);


--
-- Name: collaboration_group_workspaces collaboration_group_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspaces
    ADD CONSTRAINT collaboration_group_workspaces_pkey PRIMARY KEY (group_id);


--
-- Name: collaboration_groups collaboration_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_pkey PRIMARY KEY (id);


--
-- Name: contact_organization_exit_requests contact_organization_exit_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_exit_requests
    ADD CONSTRAINT contact_organization_exit_requests_pkey PRIMARY KEY (id);


--
-- Name: contact_organization_members contact_organization_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_members
    ADD CONSTRAINT contact_organization_members_pkey PRIMARY KEY (organization_id, user_id);


--
-- Name: contact_organization_notices contact_organization_notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_notices
    ADD CONSTRAINT contact_organization_notices_pkey PRIMARY KEY (id);


--
-- Name: contact_organizations contact_organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organizations
    ADD CONSTRAINT contact_organizations_pkey PRIMARY KEY (id);


--
-- Name: email_verifications email_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_pkey PRIMARY KEY (id);


--
-- Name: friend_requests friend_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_user_a_id_user_b_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_a_id_user_b_id_key UNIQUE (user_a_id, user_b_id);


--
-- Name: large_file_objects large_file_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_objects
    ADD CONSTRAINT large_file_objects_pkey PRIMARY KEY (id);


--
-- Name: large_file_upload_chunks large_file_upload_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_chunks
    ADD CONSTRAINT large_file_upload_chunks_pkey PRIMARY KEY (upload_id, chunk_index);


--
-- Name: large_file_upload_sessions large_file_upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_sessions
    ADD CONSTRAINT large_file_upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: social_contact_remarks social_contact_remarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_contact_remarks
    ADD CONSTRAINT social_contact_remarks_pkey PRIMARY KEY (owner_user_id, target_user_id);


--
-- Name: social_conversation_preference_commands social_conversation_preference_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preference_commands
    ADD CONSTRAINT social_conversation_preference_commands_pkey PRIMARY KEY (command_id);


--
-- Name: social_conversation_preferences social_conversation_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preferences
    ADD CONSTRAINT social_conversation_preferences_pkey PRIMARY KEY (account_workspace_id, user_id, conversation_kind, conversation_id);


--
-- Name: social_message_files social_message_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_message_files
    ADD CONSTRAINT social_message_files_pkey PRIMARY KEY (id);


--
-- Name: social_messages social_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_messages
    ADD CONSTRAINT social_messages_pkey PRIMARY KEY (id);


--
-- Name: social_realtime_events social_realtime_events_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_realtime_events
    ADD CONSTRAINT social_realtime_events_id_key UNIQUE (id);


--
-- Name: social_realtime_events social_realtime_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_realtime_events
    ADD CONSTRAINT social_realtime_events_pkey PRIMARY KEY (sequence_id);


--
-- Name: social_ubuddy_capability_profile_commands social_ubuddy_capability_profile_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_ubuddy_capability_profile_commands
    ADD CONSTRAINT social_ubuddy_capability_profile_commands_pkey PRIMARY KEY (command_id);


--
-- Name: social_ubuddy_capability_profiles social_ubuddy_capability_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_ubuddy_capability_profiles
    ADD CONSTRAINT social_ubuddy_capability_profiles_pkey PRIMARY KEY (owner_user_id, ubuddy_agent_instance_id, profile_revision);


--
-- Name: task_node_result_versions task_node_result_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_node_result_versions
    ADD CONSTRAINT task_node_result_versions_pkey PRIMARY KEY (id);


--
-- Name: task_node_result_versions task_node_result_versions_task_node_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_node_result_versions
    ADD CONSTRAINT task_node_result_versions_task_node_id_version_no_key UNIQUE (task_node_id, version_no);


--
-- Name: user_blocks user_blocks_blocker_id_blocked_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (id);


--
-- Name: user_presence user_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_account_memberships_v8_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_memberships_v8_user ON public.account_memberships_v8 USING btree (user_id, status, updated_at DESC);


--
-- Name: idx_account_workspace_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_workspace_memberships_user ON public.account_workspace_memberships USING btree (user_id, status, updated_at DESC);


--
-- Name: idx_account_workspaces_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_account_workspaces_organization ON public.account_workspaces USING btree (organization_id) WHERE (organization_id <> ''::text);


--
-- Name: idx_accounts_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_accounts_organization ON public.accounts USING btree (organization_id) WHERE (account_kind = 'organization'::text);


--
-- Name: idx_accounts_personal_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_accounts_personal_owner ON public.accounts USING btree (owner_user_id) WHERE (account_kind = 'personal'::text);


--
-- Name: idx_agent_delegation_execution_leases_recipient_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegation_execution_leases_recipient_expiry ON public.agent_delegation_execution_leases USING btree (recipient_user_id, lease_expires_at);


--
-- Name: idx_agent_delegation_revisions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegation_revisions ON public.agent_delegation_revisions USING btree (delegation_id, revision_no DESC);


--
-- Name: idx_agent_delegation_workspace_messages_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegation_workspace_messages_owner ON public.agent_delegation_workspace_messages USING btree (delegation_id, user_id, created_at);


--
-- Name: idx_agent_delegation_workspace_messages_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_delegation_workspace_messages_source_event ON public.agent_delegation_workspace_messages USING btree (delegation_id, user_id, source_event_id) WHERE (source_event_id <> ''::text);


--
-- Name: idx_agent_delegation_workspace_messages_source_group; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_delegation_workspace_messages_source_group ON public.agent_delegation_workspace_messages USING btree (delegation_id, user_id, source_group_message_id) WHERE (source_group_message_id <> ''::text);


--
-- Name: idx_agent_delegation_workspaces_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegation_workspaces_user ON public.agent_delegation_workspaces USING btree (user_id, updated_at DESC);


--
-- Name: idx_agent_delegations_client_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_delegations_client_request ON public.agent_delegations USING btree (account_workspace_id, requester_user_id, client_request_id) WHERE (client_request_id <> ''::text);


--
-- Name: idx_agent_delegations_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegations_group ON public.agent_delegations USING btree (group_id, updated_at DESC);


--
-- Name: idx_agent_delegations_recipient_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegations_recipient_status ON public.agent_delegations USING btree (recipient_user_id, status, updated_at DESC);


--
-- Name: idx_agent_delegations_requester_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegations_requester_status ON public.agent_delegations USING btree (requester_user_id, status, updated_at DESC);


--
-- Name: idx_agent_delegations_workspace_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_delegations_workspace_user ON public.agent_delegations USING btree (account_workspace_id, requester_user_id, recipient_user_id, updated_at DESC);


--
-- Name: idx_chat_group_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_group_members_user ON public.chat_group_members USING btree (user_id, status, joined_at DESC);


--
-- Name: idx_chat_group_message_files_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_group_message_files_group ON public.chat_group_message_files USING btree (group_id, created_at DESC);


--
-- Name: idx_chat_group_messages_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_group_messages_group ON public.chat_group_messages USING btree (group_id, created_at, id);


--
-- Name: idx_chat_group_messages_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_chat_group_messages_source_event ON public.chat_group_messages USING btree (group_id, source_event_id) WHERE (source_event_id <> ''::text);


--
-- Name: idx_chat_groups_audience_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_groups_audience_member ON public.chat_groups USING btree (audience_scope, status, updated_at DESC);


--
-- Name: idx_chat_groups_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_groups_workspace ON public.chat_groups USING btree (account_workspace_id, status, updated_at DESC);


--
-- Name: idx_chat_sessions_user_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_user_pinned ON public.chat_sessions USING btree (user_id, pinned_at DESC) WHERE (pinned_at IS NOT NULL);


--
-- Name: idx_chat_sessions_user_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_user_recent ON public.chat_sessions USING btree (user_id, status, updated_at DESC);


--
-- Name: idx_chat_sessions_workspace_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_workspace_recent ON public.chat_sessions USING btree (account_workspace_id, user_id, status, updated_at DESC);


--
-- Name: idx_cloud_agent_alias_repairs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_agent_alias_repairs_user ON public.cloud_agent_instance_alias_repairs USING btree (user_id, created_at DESC);


--
-- Name: idx_cloud_agent_cohorts_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_agent_cohorts_key ON public.cloud_agent_cohorts USING btree (cohort_key);


--
-- Name: idx_cloud_agent_context_spaces_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_agent_context_spaces_identity ON public.cloud_agent_context_spaces USING btree (user_id, user_agent_instance_id, context_kind, COALESCE(memory_document_id, ''::text), project_id, task_run_id, delegation_id, group_id, relationship_user_id);


--
-- Name: idx_cloud_agent_context_spaces_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_agent_context_spaces_instance ON public.cloud_agent_context_spaces USING btree (user_id, user_agent_instance_id, lifecycle_state, updated_at);


--
-- Name: idx_cloud_agent_context_states_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_agent_context_states_updated ON public.cloud_agent_context_states USING btree (owner_user_id, updated_at, user_agent_instance_id);


--
-- Name: idx_cloud_chat_context_states_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_chat_context_states_session ON public.cloud_chat_context_states USING btree (owner_user_id, session_id, context_space_id);


--
-- Name: idx_cloud_chat_context_states_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_chat_context_states_updated ON public.cloud_chat_context_states USING btree (owner_user_id, updated_at, id);


--
-- Name: idx_cloud_cluster_claims_consumer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_cluster_claims_consumer ON public.cloud_cluster_evidence_claims USING btree (consumer_id, claim_state, updated_at);


--
-- Name: idx_cloud_conversation_aliases_v7_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_conversation_aliases_v7_canonical ON public.cloud_conversation_aliases_v7 USING btree (user_id, canonical_conversation_id);


--
-- Name: idx_cloud_devices_v6_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_devices_v6_user_status ON public.cloud_devices_v6 USING btree (user_id, status, updated_at);


--
-- Name: idx_cloud_employee_roster_bootstrap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_employee_roster_bootstrap ON public.cloud_employee_roster_states USING btree (bootstrap_status, updated_at);


--
-- Name: idx_cloud_evidence_access_audit_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_access_audit_run ON public.cloud_evolution_evidence_access_audits USING btree (run_id, created_at, id);


--
-- Name: idx_cloud_evidence_access_audit_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_access_audit_subject ON public.cloud_evolution_evidence_access_audits USING btree (evidence_id, created_at, id);


--
-- Name: idx_cloud_evidence_lineage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_lineage ON public.cloud_evolution_evidence USING btree (owner_user_id, user_agent_instance_id, lineage_key, occurred_at, evidence_id);


--
-- Name: idx_cloud_evidence_personal_threshold; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_personal_threshold ON public.cloud_evolution_evidence USING btree (owner_user_id, user_agent_instance_id, personal_threshold_eligible, occurred_at, evidence_id) WHERE (quarantine_reason = ''::text);


--
-- Name: idx_cloud_evidence_quarantine_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_quarantine_subject ON public.cloud_evolution_evidence_quarantine USING btree (owner_user_id, resolution_status, created_at, id);


--
-- Name: idx_cloud_evidence_validation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_validation ON public.cloud_evolution_evidence USING btree (validation_status, ingested_at, evidence_id);


--
-- Name: idx_cloud_evidence_validation_jobs_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evidence_validation_jobs_claim ON public.cloud_evolution_evidence_validation_jobs USING btree (status, available_at, lease_expires_at);


--
-- Name: idx_cloud_evolution_active_cluster_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_evolution_active_cluster_run ON public.cloud_evolution_runs USING btree (cohort_id) WHERE ((evolution_scope = 'cluster'::text) AND (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'proposed'::text, 'canary'::text])));


--
-- Name: idx_cloud_evolution_active_personal_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_evolution_active_personal_run ON public.cloud_evolution_runs USING btree (user_agent_instance_id) WHERE ((evolution_scope = 'personal'::text) AND (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'running'::text, 'proposed'::text, 'failed_retryable'::text])));


--
-- Name: idx_cloud_evolution_evidence_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evolution_evidence_subject ON public.cloud_evolution_evidence USING btree (owner_user_id, user_agent_instance_id, occurred_at, evidence_id);


--
-- Name: idx_cloud_evolution_key_rotation_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evolution_key_rotation_due ON public.cloud_evolution_key_rotation_jobs USING btree (status, available_at, evidence_id);


--
-- Name: idx_cloud_evolution_usage_consumer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evolution_usage_consumer ON public.cloud_evolution_evidence_usage USING btree (evolution_scope, consumer_id, status, updated_at);


--
-- Name: idx_cloud_evolution_usage_events_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_evolution_usage_events_subject ON public.cloud_evolution_evidence_usage_events USING btree (evolution_scope, consumer_id, occurred_at, id);


--
-- Name: idx_cloud_file_objects_v6_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_file_objects_v6_cleanup ON public.cloud_file_objects_v6 USING btree (storage_status, unreferenced_at);


--
-- Name: idx_cloud_leadership_action_command; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_leadership_action_command ON public.cloud_leadership_promotion_actions USING btree (owner_user_id, command_id) WHERE (command_id <> ''::text);


--
-- Name: idx_cloud_leadership_appeal_command; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_leadership_appeal_command ON public.cloud_leadership_appeals USING btree (owner_user_id, command_id) WHERE (command_id <> ''::text);


--
-- Name: idx_cloud_leadership_appeals_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_leadership_appeals_review ON public.cloud_leadership_appeals USING btree (status, created_at);


--
-- Name: idx_cloud_leadership_events_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_leadership_events_instance ON public.cloud_agent_leadership_events USING btree (user_agent_instance_id, occurred_at);


--
-- Name: idx_cloud_leadership_scope_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_leadership_scope_agent ON public.cloud_leadership_assignments USING btree (work_scope_id, user_id, agent_instance_id, status, valid_from, valid_until);


--
-- Name: idx_cloud_market_adoption_command; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_market_adoption_command ON public.cloud_market_adoption_actions USING btree (user_id, command_id, section_id) WHERE (command_id <> ''::text);


--
-- Name: idx_cloud_market_canary_assignments_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_market_canary_assignments_instance ON public.cloud_market_canary_assignments USING btree (user_agent_instance_id, status, started_at);


--
-- Name: idx_cloud_market_canary_opt_ins_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_market_canary_opt_ins_family ON public.cloud_market_canary_opt_ins USING btree (agent_family_id, status, updated_at);


--
-- Name: idx_cloud_market_candidate_privacy_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_market_candidate_privacy_review ON public.cloud_market_candidate_privacy_reviews USING btree (candidate_id, review_stage, agent_family_id);


--
-- Name: idx_cloud_market_candidate_support_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_market_candidate_support_section ON public.cloud_market_candidate_section_supports USING btree (candidate_id, agent_family_id, section_id, contributor_id);


--
-- Name: idx_cloud_memory_documents_context_v5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_memory_documents_context_v5 ON public.cloud_memory_documents_v3 USING btree (user_id, user_agent_instance_id, scope, task_run_id, project_id, relationship_id, updated_at);


--
-- Name: idx_cloud_memory_documents_slot_identity_v3; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_memory_documents_slot_identity_v3 ON public.cloud_memory_documents_v3 USING btree (user_id, user_agent_instance_id, scope, slot_no, task_run_id, project_id, relationship_id);


--
-- Name: idx_cloud_memory_sync_mapping_active_document; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_memory_sync_mapping_active_document ON public.cloud_memory_sync_mappings USING btree (owner_user_id, memory_document_id) WHERE (status = 'active'::text);


--
-- Name: idx_cloud_memory_sync_mapping_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_memory_sync_mapping_document ON public.cloud_memory_sync_mappings USING btree (owner_user_id, memory_document_id, status, updated_at);


--
-- Name: idx_cloud_one_active_general_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_one_active_general_memory ON public.cloud_memory_documents_v3 USING btree (user_id, user_agent_instance_id) WHERE ((scope = 'general'::text) AND (lifecycle_state = 'active'::text));


--
-- Name: idx_cloud_one_primary_agent_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_one_primary_agent_conversation ON public.cloud_conversations_v6 USING btree (user_id, COALESCE((payload_json ->> 'accountWorkspaceId'::text), (payload_json ->> 'account_workspace_id'::text), (payload_json ->> 'workspaceId'::text), (payload_json ->> 'workspace_id'::text), 'workspace_personal'::text), COALESCE((payload_json ->> 'agentInstanceId'::text), (payload_json ->> 'agent_instance_id'::text), ''::text)) WHERE ((conversation_role = 'primary'::text) AND (write_state = 'writable'::text) AND (COALESCE((payload_json ->> 'agentInstanceId'::text), (payload_json ->> 'agent_instance_id'::text), ''::text) <> ''::text) AND (COALESCE((payload_json ->> 'conversationKind'::text), (payload_json ->> 'conversation_kind'::text), 'direct'::text) = 'direct'::text) AND (COALESCE((payload_json ->> 'status'::text), 'active'::text) <> 'deleted'::text));


--
-- Name: idx_cloud_performance_authoritative_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_performance_authoritative_source ON public.cloud_agent_performance_events USING btree (owner_user_id, user_agent_instance_id, source_kind, source_id, source_version_id) WHERE ((source_id <> ''::text) AND (validation_status = 'validated'::text));


--
-- Name: idx_cloud_performance_authoritative_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_performance_authoritative_window ON public.cloud_agent_performance_events USING btree (user_agent_instance_id, authority, validation_status, occurred_at);


--
-- Name: idx_cloud_performance_events_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_performance_events_instance ON public.cloud_agent_performance_events USING btree (user_agent_instance_id, occurred_at);


--
-- Name: idx_cloud_performance_peer_baseline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_performance_peer_baseline ON public.cloud_agent_performance_events USING btree (task_type_key, agent_family_id, authority, validation_status, occurred_at);


--
-- Name: idx_cloud_personal_actions_proposal_v4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_personal_actions_proposal_v4 ON public.cloud_personal_evolution_actions_v4 USING btree (user_id, proposal_id, received_at);


--
-- Name: idx_cloud_personal_evolution_schedule_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_personal_evolution_schedule_due ON public.cloud_personal_evolution_schedule_states USING btree (next_eligible_at, user_agent_instance_id);


--
-- Name: idx_cloud_personal_proposals_instance_v4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_personal_proposals_instance_v4 ON public.cloud_personal_evolution_proposals_v4 USING btree (user_id, user_agent_instance_id, updated_at);


--
-- Name: idx_cloud_personal_version_commands_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_personal_version_commands_instance ON public.cloud_personal_version_commands USING btree (user_id, user_agent_instance_id, created_at DESC);


--
-- Name: idx_cloud_recruitment_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_recruitment_events_user ON public.cloud_user_agent_recruitment_events USING btree (user_id, created_at);


--
-- Name: idx_cloud_sync_changes_v6_cursor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_changes_v6_cursor ON public.cloud_sync_changes_v6 USING btree (user_id, sequence_id);


--
-- Name: idx_cloud_sync_changes_v8_cursor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_changes_v8_cursor ON public.cloud_sync_changes_v8 USING btree (account_id, sequence_id);


--
-- Name: idx_cloud_sync_device_cursors_v7_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_device_cursors_v7_seen ON public.cloud_sync_device_cursors_v7 USING btree (user_id, last_seen_at);


--
-- Name: idx_cloud_sync_entities_v6_changed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_entities_v6_changed ON public.cloud_sync_entities_v6 USING btree (user_id, updated_at, entity_type, entity_id);


--
-- Name: idx_cloud_sync_entities_v8_changed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_entities_v8_changed ON public.cloud_sync_entities_v8 USING btree (account_id, updated_at, entity_type, entity_id);


--
-- Name: idx_cloud_sync_history_repairs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_sync_history_repairs_user ON public.cloud_sync_history_repairs USING btree (user_id, created_at DESC);


--
-- Name: idx_cloud_task_events_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_task_events_source ON public.cloud_task_events USING btree (owner_user_id, task_run_id, task_node_id, created_at);


--
-- Name: idx_cloud_task_key_access_audits_v6_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_task_key_access_audits_v6_subject ON public.cloud_task_key_access_audits_v6 USING btree (user_id, task_run_id, created_at);


--
-- Name: idx_cloud_task_runs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_task_runs_workspace ON public.cloud_task_runs USING btree (account_workspace_id, owner_user_id, updated_at DESC);


--
-- Name: idx_cloud_task_security_owner_v5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_task_security_owner_v5 ON public.cloud_task_security_contexts_v5 USING btree (user_id, owner_user_id, status, updated_at);


--
-- Name: idx_cloud_user_agent_instances_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_user_agent_instances_family ON public.cloud_user_agent_instances_v3 USING btree (user_id, agent_family_id, created_at, id);


--
-- Name: idx_cloud_user_agent_instances_unique_family_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cloud_user_agent_instances_unique_family_seq ON public.cloud_user_agent_instances_v3 USING btree (user_id, agent_family_id, family_instance_seq) WHERE (family_instance_seq > 0);


--
-- Name: idx_cloud_work_memory_audits_scope_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_work_memory_audits_scope_created ON public.cloud_work_memory_access_audits USING btree (work_scope_id, created_at DESC);


--
-- Name: idx_cloud_work_memory_scope_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_work_memory_scope_target ON public.cloud_work_memory_versions USING btree (work_scope_id, agent_instance_id, published_at DESC);


--
-- Name: idx_cloud_work_participants_scope_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_work_participants_scope_status ON public.cloud_work_participants USING btree (work_scope_id, status, user_id, agent_instance_id);


--
-- Name: idx_collaboration_files_delegation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_files_delegation ON public.collaboration_files USING btree (delegation_id, created_at DESC);


--
-- Name: idx_collaboration_files_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_files_group ON public.collaboration_files USING btree (group_id, created_at DESC);


--
-- Name: idx_collaboration_group_messages_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_collaboration_group_messages_source_event ON public.collaboration_group_messages USING btree (group_id, source_event_id) WHERE (source_event_id <> ''::text);


--
-- Name: idx_collaboration_group_messages_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_group_messages_workspace ON public.collaboration_group_messages USING btree (account_workspace_id, group_id, created_at);


--
-- Name: idx_collaboration_group_workspace_files_revision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_group_workspace_files_revision ON public.collaboration_group_workspace_files USING btree (group_id, revision);


--
-- Name: idx_collaboration_groups_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_groups_workspace ON public.collaboration_groups USING btree (account_workspace_id, updated_at DESC);


--
-- Name: idx_collaboration_groups_workspace_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_collaboration_groups_workspace_request ON public.collaboration_groups USING btree (account_workspace_id, owner_user_id, client_request_id);


--
-- Name: idx_collaboration_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_members_user ON public.collaboration_group_members USING btree (user_id, status, joined_at DESC);


--
-- Name: idx_collaboration_messages_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collaboration_messages_group ON public.collaboration_group_messages USING btree (group_id, created_at);


--
-- Name: idx_contact_organization_exit_requests_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_organization_exit_requests_org ON public.contact_organization_exit_requests USING btree (organization_id, status, created_at);


--
-- Name: idx_contact_organization_exit_requests_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contact_organization_exit_requests_pending ON public.contact_organization_exit_requests USING btree (organization_id, requester_user_id) WHERE (status = 'pending'::text);


--
-- Name: idx_contact_organization_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_organization_members_user ON public.contact_organization_members USING btree (user_id, updated_at DESC);


--
-- Name: idx_contact_organization_notices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_organization_notices_user ON public.contact_organization_notices USING btree (user_id, read_at, created_at DESC);


--
-- Name: idx_contact_organizations_number_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contact_organizations_number_ci ON public.contact_organizations USING btree (lower(organization_number));


--
-- Name: idx_contact_organizations_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_organizations_owner ON public.contact_organizations USING btree (owner_user_id, updated_at DESC);


--
-- Name: idx_email_verifications_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verifications_lookup ON public.email_verifications USING btree (email, purpose, consumed, created_at);


--
-- Name: idx_friend_requests_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_friend_requests_recipient ON public.friend_requests USING btree (recipient_id, status);


--
-- Name: idx_friend_requests_requester; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_friend_requests_requester ON public.friend_requests USING btree (requester_id, status);


--
-- Name: idx_friendships_user_a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_friendships_user_a ON public.friendships USING btree (user_a_id, status);


--
-- Name: idx_friendships_user_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_friendships_user_b ON public.friendships USING btree (user_b_id, status);


--
-- Name: idx_large_file_objects_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_large_file_objects_scope ON public.large_file_objects USING btree (scope_kind, scope_id, created_at DESC);


--
-- Name: idx_large_file_objects_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_large_file_objects_workspace ON public.large_file_objects USING btree (account_workspace_id, owner_user_id, created_at DESC);


--
-- Name: idx_large_file_upload_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_large_file_upload_sessions_expiry ON public.large_file_upload_sessions USING btree (status, expires_at);


--
-- Name: idx_large_file_upload_sessions_owner_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_large_file_upload_sessions_owner_file ON public.large_file_upload_sessions USING btree (owner_user_id, file_id, updated_at DESC);


--
-- Name: idx_refresh_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_social_contact_remarks_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_contact_remarks_target ON public.social_contact_remarks USING btree (target_user_id, updated_at DESC);


--
-- Name: idx_social_conversation_preference_commands_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_conversation_preference_commands_user ON public.social_conversation_preference_commands USING btree (user_id, created_at DESC);


--
-- Name: idx_social_conversation_preferences_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_conversation_preferences_user ON public.social_conversation_preferences USING btree (user_id, archived, updated_at DESC);


--
-- Name: idx_social_message_files_direct; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_message_files_direct ON public.social_message_files USING btree (owner_user_id, recipient_user_id, created_at DESC);


--
-- Name: idx_social_message_files_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_message_files_group ON public.social_message_files USING btree (group_id, created_at DESC);


--
-- Name: idx_social_message_files_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_message_files_workspace ON public.social_message_files USING btree (account_workspace_id, owner_user_id, recipient_user_id, created_at DESC);


--
-- Name: idx_social_messages_pair_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_messages_pair_created ON public.social_messages USING btree (sender_user_id, recipient_user_id, created_at);


--
-- Name: idx_social_messages_recipient_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_messages_recipient_created ON public.social_messages USING btree (recipient_user_id, created_at DESC);


--
-- Name: idx_social_messages_workspace_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_messages_workspace_recipient ON public.social_messages USING btree (account_workspace_id, recipient_user_id, created_at DESC);


--
-- Name: idx_social_realtime_events_recipient_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_realtime_events_recipient_sequence ON public.social_realtime_events USING btree (recipient_user_id, sequence_id);


--
-- Name: idx_social_realtime_events_workspace_recipient_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_realtime_events_workspace_recipient_sequence ON public.social_realtime_events USING btree (account_workspace_id, recipient_user_id, sequence_id);


--
-- Name: idx_social_ubuddy_profile_commands_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_ubuddy_profile_commands_owner ON public.social_ubuddy_capability_profile_commands USING btree (owner_user_id, created_at DESC);


--
-- Name: idx_social_ubuddy_profile_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_social_ubuddy_profile_one_active ON public.social_ubuddy_capability_profiles USING btree (owner_user_id) WHERE (publication_state = 'active'::text);


--
-- Name: idx_social_ubuddy_profile_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_ubuddy_profile_updated ON public.social_ubuddy_capability_profiles USING btree (owner_user_id, updated_at DESC);


--
-- Name: idx_task_node_result_versions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_node_result_versions_run ON public.task_node_result_versions USING btree (task_run_id, graph_revision_id, created_at);


--
-- Name: idx_user_blocks_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_id);


--
-- Name: idx_user_blocks_blocker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocker ON public.user_blocks USING btree (blocker_id);


--
-- Name: idx_user_presence_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_presence_seen ON public.user_presence USING btree (user_id, last_seen_at DESC);


--
-- Name: cloud_cluster_evidence_claims trg_cloud_cluster_claim_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_cluster_claim_transition BEFORE INSERT OR UPDATE ON public.cloud_cluster_evidence_claims FOR EACH ROW EXECUTE FUNCTION public.janus_guard_cluster_evidence_claim_transition();


--
-- Name: cloud_user_agent_instances_v3 trg_cloud_cluster_participation_authority; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_cluster_participation_authority BEFORE INSERT OR UPDATE OF sync_enabled, status, personal_evolution_consent, cluster_contribution_consent, personal_skill_auto_activate ON public.cloud_user_agent_instances_v3 FOR EACH ROW EXECUTE FUNCTION public.janus_set_cluster_participation_authority();


--
-- Name: cloud_evolution_evidence_usage trg_cloud_evidence_usage_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_evidence_usage_transition BEFORE INSERT OR UPDATE ON public.cloud_evolution_evidence_usage FOR EACH ROW EXECUTE FUNCTION public.janus_guard_evolution_evidence_usage_transition();


--
-- Name: cloud_market_version_sections trg_cloud_market_section_delete_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_market_section_delete_immutable BEFORE DELETE ON public.cloud_market_version_sections FOR EACH ROW EXECUTE FUNCTION public.janus_guard_released_market_section_content();


--
-- Name: cloud_market_version_sections trg_cloud_market_section_update_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_market_section_update_immutable BEFORE UPDATE ON public.cloud_market_version_sections FOR EACH ROW EXECUTE FUNCTION public.janus_guard_released_market_section_content();


--
-- Name: cloud_market_agent_versions trg_cloud_market_version_content_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cloud_market_version_content_immutable BEFORE UPDATE ON public.cloud_market_agent_versions FOR EACH ROW EXECUTE FUNCTION public.janus_guard_released_market_version_content();


--
-- Name: contact_organization_members trg_sync_account_workspace_membership; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_account_workspace_membership AFTER INSERT OR DELETE OR UPDATE ON public.contact_organization_members FOR EACH ROW EXECUTE FUNCTION public.sync_account_workspace_membership();


--
-- Name: contact_organizations trg_sync_account_workspace_organization; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_account_workspace_organization AFTER INSERT OR DELETE OR UPDATE ON public.contact_organizations FOR EACH ROW EXECUTE FUNCTION public.sync_account_workspace_organization();


--
-- Name: contact_organization_members trg_sync_organization_account_membership_v8; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_organization_account_membership_v8 AFTER INSERT OR DELETE OR UPDATE ON public.contact_organization_members FOR EACH ROW EXECUTE FUNCTION public.sync_organization_account_membership_v8();


--
-- Name: contact_organizations trg_sync_organization_account_v8; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_organization_account_v8 AFTER INSERT OR DELETE OR UPDATE ON public.contact_organizations FOR EACH ROW EXECUTE FUNCTION public.sync_organization_account_v8();


--
-- Name: users trg_sync_personal_account_v8; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_personal_account_v8 AFTER INSERT OR UPDATE OF display_name, updated_at ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_personal_account_v8();


--
-- Name: users trg_sync_personal_account_workspace_membership; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_personal_account_workspace_membership AFTER INSERT OR UPDATE OF display_name, avatar_url, updated_at ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_personal_account_workspace_membership();


--
-- Name: account_memberships_v8 account_memberships_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_memberships_v8
    ADD CONSTRAINT account_memberships_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_memberships_v8 account_memberships_v8_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_memberships_v8
    ADD CONSTRAINT account_memberships_v8_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: account_workspace_bindings_v8 account_workspace_bindings_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_bindings_v8
    ADD CONSTRAINT account_workspace_bindings_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_workspace_bindings_v8 account_workspace_bindings_v8_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_bindings_v8
    ADD CONSTRAINT account_workspace_bindings_v8_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: account_workspace_memberships account_workspace_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_memberships
    ADD CONSTRAINT account_workspace_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: account_workspace_memberships account_workspace_memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_workspace_memberships
    ADD CONSTRAINT account_workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_execution_leases agent_delegation_execution_leases_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_execution_leases
    ADD CONSTRAINT agent_delegation_execution_leases_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.agent_delegations(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_execution_leases agent_delegation_execution_leases_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_execution_leases
    ADD CONSTRAINT agent_delegation_execution_leases_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_revisions agent_delegation_revisions_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_revisions
    ADD CONSTRAINT agent_delegation_revisions_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_revisions agent_delegation_revisions_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_revisions
    ADD CONSTRAINT agent_delegation_revisions_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.agent_delegations(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_workspace_messages agent_delegation_workspace_messages_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspace_messages
    ADD CONSTRAINT agent_delegation_workspace_messages_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.agent_delegations(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_workspace_messages agent_delegation_workspace_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspace_messages
    ADD CONSTRAINT agent_delegation_workspace_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_workspaces agent_delegation_workspaces_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspaces
    ADD CONSTRAINT agent_delegation_workspaces_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.agent_delegations(id) ON DELETE CASCADE;


--
-- Name: agent_delegation_workspaces agent_delegation_workspaces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegation_workspaces
    ADD CONSTRAINT agent_delegation_workspaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_delegations agent_delegations_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_delegations agent_delegations_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_delegations
    ADD CONSTRAINT agent_delegations_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_group_members chat_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_group_members chat_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_members
    ADD CONSTRAINT chat_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: chat_group_message_files chat_group_message_files_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_message_files
    ADD CONSTRAINT chat_group_message_files_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: chat_group_message_files chat_group_message_files_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_message_files
    ADD CONSTRAINT chat_group_message_files_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_group_message_files chat_group_message_files_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_message_files
    ADD CONSTRAINT chat_group_message_files_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_group_messages chat_group_messages_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_messages
    ADD CONSTRAINT chat_group_messages_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: chat_group_messages chat_group_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_messages
    ADD CONSTRAINT chat_group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_group_messages chat_group_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_messages
    ADD CONSTRAINT chat_group_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: chat_group_operations chat_group_operations_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_operations
    ADD CONSTRAINT chat_group_operations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: chat_group_operations chat_group_operations_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_group_operations
    ADD CONSTRAINT chat_group_operations_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.chat_groups(id) ON DELETE CASCADE;


--
-- Name: chat_groups chat_groups_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: chat_groups chat_groups_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_groups
    ADD CONSTRAINT chat_groups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: chat_sessions chat_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_context_spaces cloud_agent_context_spaces_user_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_spaces
    ADD CONSTRAINT cloud_agent_context_spaces_user_id_fkey1 FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_context_spaces cloud_agent_context_spaces_user_id_memory_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_spaces
    ADD CONSTRAINT cloud_agent_context_spaces_user_id_memory_document_id_fkey FOREIGN KEY (user_id, memory_document_id) REFERENCES public.cloud_memory_documents_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_agent_context_spaces cloud_agent_context_spaces_user_id_user_agent_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_spaces
    ADD CONSTRAINT cloud_agent_context_spaces_user_id_user_agent_instance_id_fkey FOREIGN KEY (user_id, user_agent_instance_id) REFERENCES public.cloud_user_agent_instances_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_agent_context_states cloud_agent_context_states_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_states
    ADD CONSTRAINT cloud_agent_context_states_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_context_states cloud_agent_context_states_owner_user_id_user_agent_instan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_context_states
    ADD CONSTRAINT cloud_agent_context_states_owner_user_id_user_agent_instan_fkey FOREIGN KEY (owner_user_id, user_agent_instance_id) REFERENCES public.cloud_user_agent_instances_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_agent_instance_alias_repairs cloud_agent_instance_alias_repairs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_instance_alias_repairs
    ADD CONSTRAINT cloud_agent_instance_alias_repairs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_leadership_evaluations cloud_agent_leadership_evaluations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_evaluations
    ADD CONSTRAINT cloud_agent_leadership_evaluations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_leadership_events cloud_agent_leadership_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_events
    ADD CONSTRAINT cloud_agent_leadership_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_leadership_levels cloud_agent_leadership_levels_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_leadership_levels
    ADD CONSTRAINT cloud_agent_leadership_levels_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_agent_performance_events cloud_agent_performance_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_agent_performance_events
    ADD CONSTRAINT cloud_agent_performance_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_cluster_evidence_claims cloud_cluster_evidence_claims_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_cluster_evidence_claims
    ADD CONSTRAINT cloud_cluster_evidence_claims_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_cluster_run_evidence cloud_cluster_run_evidence_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_cluster_run_evidence
    ADD CONSTRAINT cloud_cluster_run_evidence_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_cluster_run_evidence cloud_cluster_run_evidence_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_cluster_run_evidence
    ADD CONSTRAINT cloud_cluster_run_evidence_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cloud_evolution_runs(id) ON DELETE CASCADE;


--
-- Name: cloud_conversation_aliases_v7 cloud_conversation_aliases_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_conversation_aliases_v7
    ADD CONSTRAINT cloud_conversation_aliases_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_conversations_v6 cloud_conversations_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_conversations_v6
    ADD CONSTRAINT cloud_conversations_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_device_token_nonces_v6 cloud_device_token_nonces_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_device_token_nonces_v6
    ADD CONSTRAINT cloud_device_token_nonces_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_devices_v6 cloud_devices_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_devices_v6
    ADD CONSTRAINT cloud_devices_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_effective_skill_projections cloud_effective_skill_projections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_effective_skill_projections
    ADD CONSTRAINT cloud_effective_skill_projections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_employee_roster_states cloud_employee_roster_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_employee_roster_states
    ADD CONSTRAINT cloud_employee_roster_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_apply_journals cloud_evolution_apply_journals_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_apply_journals
    ADD CONSTRAINT cloud_evolution_apply_journals_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cloud_evolution_runs(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evaluations cloud_evolution_evaluations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evaluations
    ADD CONSTRAINT cloud_evolution_evaluations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cloud_evolution_runs(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evidence cloud_evolution_evidence_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence
    ADD CONSTRAINT cloud_evolution_evidence_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evidence_usage_events cloud_evolution_evidence_usage_events_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_usage_events
    ADD CONSTRAINT cloud_evolution_evidence_usage_events_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evidence_usage cloud_evolution_evidence_usage_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_usage
    ADD CONSTRAINT cloud_evolution_evidence_usage_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evidence_validation_jobs cloud_evolution_evidence_validation_jobs_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_evidence_validation_jobs
    ADD CONSTRAINT cloud_evolution_evidence_validation_jobs_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_jobs cloud_evolution_jobs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_jobs
    ADD CONSTRAINT cloud_evolution_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cloud_evolution_runs(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_key_rotation_jobs cloud_evolution_key_rotation_jobs_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_key_rotation_jobs
    ADD CONSTRAINT cloud_evolution_key_rotation_jobs_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_run_snapshots cloud_evolution_run_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_evolution_run_snapshots
    ADD CONSTRAINT cloud_evolution_run_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cloud_evolution_runs(id) ON DELETE CASCADE;


--
-- Name: cloud_file_objects_v6 cloud_file_objects_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_file_objects_v6
    ADD CONSTRAINT cloud_file_objects_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_file_refs_v6 cloud_file_refs_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_file_refs_v6
    ADD CONSTRAINT cloud_file_refs_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_leadership_appeals cloud_leadership_appeals_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_appeals
    ADD CONSTRAINT cloud_leadership_appeals_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_leadership_assignments cloud_leadership_assignments_appointed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_assignments
    ADD CONSTRAINT cloud_leadership_assignments_appointed_by_user_id_fkey FOREIGN KEY (appointed_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_leadership_assignments cloud_leadership_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_assignments
    ADD CONSTRAINT cloud_leadership_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_leadership_assignments cloud_leadership_assignments_work_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_assignments
    ADD CONSTRAINT cloud_leadership_assignments_work_scope_id_fkey FOREIGN KEY (work_scope_id) REFERENCES public.cloud_work_scopes(id) ON DELETE CASCADE;


--
-- Name: cloud_leadership_promotion_actions cloud_leadership_promotion_actions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_leadership_promotion_actions
    ADD CONSTRAINT cloud_leadership_promotion_actions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_market_adoption_actions cloud_market_adoption_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_adoption_actions
    ADD CONSTRAINT cloud_market_adoption_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_market_canary_assignments cloud_market_canary_assignments_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_assignments
    ADD CONSTRAINT cloud_market_canary_assignments_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.cloud_market_agent_candidates(id) ON DELETE CASCADE;


--
-- Name: cloud_market_canary_evaluations cloud_market_canary_evaluations_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_canary_evaluations
    ADD CONSTRAINT cloud_market_canary_evaluations_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.cloud_market_agent_candidates(id) ON DELETE CASCADE;


--
-- Name: cloud_market_candidate_privacy_reviews cloud_market_candidate_privacy_reviews_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_privacy_reviews
    ADD CONSTRAINT cloud_market_candidate_privacy_reviews_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.cloud_market_agent_candidates(id) ON DELETE CASCADE;


--
-- Name: cloud_market_candidate_section_supports cloud_market_candidate_section_supports_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_section_supports
    ADD CONSTRAINT cloud_market_candidate_section_supports_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.cloud_market_agent_candidates(id) ON DELETE CASCADE;


--
-- Name: cloud_market_candidate_section_supports cloud_market_candidate_section_supports_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_market_candidate_section_supports
    ADD CONSTRAINT cloud_market_candidate_section_supports_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.cloud_evolution_evidence(evidence_id);


--
-- Name: cloud_memory_document_aliases_v3 cloud_memory_document_aliases_v3_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_aliases_v3
    ADD CONSTRAINT cloud_memory_document_aliases_v3_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_memory_document_versions_v3 cloud_memory_document_versions_v3_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_versions_v3
    ADD CONSTRAINT cloud_memory_document_versions_v3_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_memory_documents_v3 cloud_memory_documents_v3_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_documents_v3
    ADD CONSTRAINT cloud_memory_documents_v3_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_memory_sync_mappings cloud_memory_sync_mappings_owner_user_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_sync_mappings
    ADD CONSTRAINT cloud_memory_sync_mappings_owner_user_id_fkey1 FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_memory_sync_mappings cloud_memory_sync_mappings_owner_user_id_memory_document_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_sync_mappings
    ADD CONSTRAINT cloud_memory_sync_mappings_owner_user_id_memory_document_i_fkey FOREIGN KEY (owner_user_id, memory_document_id) REFERENCES public.cloud_memory_documents_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_memory_sync_mappings cloud_memory_sync_mappings_owner_user_id_user_agent_instan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_sync_mappings
    ADD CONSTRAINT cloud_memory_sync_mappings_owner_user_id_user_agent_instan_fkey FOREIGN KEY (owner_user_id, user_agent_instance_id) REFERENCES public.cloud_user_agent_instances_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_messages_v6 cloud_messages_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_messages_v6
    ADD CONSTRAINT cloud_messages_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_model_executions_v6 cloud_model_executions_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_model_executions_v6
    ADD CONSTRAINT cloud_model_executions_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_evolution_actions_v4 cloud_personal_evolution_actions_v4_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_actions_v4
    ADD CONSTRAINT cloud_personal_evolution_actions_v4_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_evolution_memory_operations_v4 cloud_personal_evolution_memory_operations_v4_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_memory_operations_v4
    ADD CONSTRAINT cloud_personal_evolution_memory_operations_v4_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_evolution_proposals_v4 cloud_personal_evolution_proposals_v4_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_evolution_proposals_v4
    ADD CONSTRAINT cloud_personal_evolution_proposals_v4_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_skill_overlay_versions cloud_personal_skill_overlay_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_skill_overlay_versions
    ADD CONSTRAINT cloud_personal_skill_overlay_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_version_commands cloud_personal_version_commands_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_version_commands
    ADD CONSTRAINT cloud_personal_version_commands_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_personal_version_health cloud_personal_version_health_personal_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_personal_version_health
    ADD CONSTRAINT cloud_personal_version_health_personal_skill_version_id_fkey FOREIGN KEY (personal_skill_version_id) REFERENCES public.cloud_personal_skill_overlay_versions(id) ON DELETE CASCADE;


--
-- Name: cloud_projects_v6 cloud_projects_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_projects_v6
    ADD CONSTRAINT cloud_projects_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_batches_v6 cloud_sync_batches_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v6
    ADD CONSTRAINT cloud_sync_batches_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_batches_v8 cloud_sync_batches_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v8
    ADD CONSTRAINT cloud_sync_batches_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_batches_v8 cloud_sync_batches_v8_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_batches_v8
    ADD CONSTRAINT cloud_sync_batches_v8_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_changes_v6 cloud_sync_changes_v6_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v6
    ADD CONSTRAINT cloud_sync_changes_v6_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.cloud_sync_batches_v6(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_changes_v6 cloud_sync_changes_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v6
    ADD CONSTRAINT cloud_sync_changes_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_changes_v8 cloud_sync_changes_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8
    ADD CONSTRAINT cloud_sync_changes_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_changes_v8 cloud_sync_changes_v8_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8
    ADD CONSTRAINT cloud_sync_changes_v8_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.cloud_sync_batches_v8(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_changes_v8 cloud_sync_changes_v8_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_changes_v8
    ADD CONSTRAINT cloud_sync_changes_v8_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_compaction_states_v7 cloud_sync_compaction_states_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_compaction_states_v7
    ADD CONSTRAINT cloud_sync_compaction_states_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_compaction_states_v8 cloud_sync_compaction_states_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_compaction_states_v8
    ADD CONSTRAINT cloud_sync_compaction_states_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_conflicts_v6 cloud_sync_conflicts_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v6
    ADD CONSTRAINT cloud_sync_conflicts_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_conflicts_v8 cloud_sync_conflicts_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v8
    ADD CONSTRAINT cloud_sync_conflicts_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_conflicts_v8 cloud_sync_conflicts_v8_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v8
    ADD CONSTRAINT cloud_sync_conflicts_v8_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.cloud_sync_batches_v8(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_conflicts_v8 cloud_sync_conflicts_v8_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_conflicts_v8
    ADD CONSTRAINT cloud_sync_conflicts_v8_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_device_cursors_v7 cloud_sync_device_cursors_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_device_cursors_v7
    ADD CONSTRAINT cloud_sync_device_cursors_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_device_cursors_v8 cloud_sync_device_cursors_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_device_cursors_v8
    ADD CONSTRAINT cloud_sync_device_cursors_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_device_cursors_v8 cloud_sync_device_cursors_v8_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_device_cursors_v8
    ADD CONSTRAINT cloud_sync_device_cursors_v8_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_entities_v6 cloud_sync_entities_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_entities_v6
    ADD CONSTRAINT cloud_sync_entities_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_entities_v8 cloud_sync_entities_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_entities_v8
    ADD CONSTRAINT cloud_sync_entities_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_grants cloud_sync_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_grants
    ADD CONSTRAINT cloud_sync_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_history_repairs cloud_sync_history_repairs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_history_repairs
    ADD CONSTRAINT cloud_sync_history_repairs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_rate_limits_v7 cloud_sync_rate_limits_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_rate_limits_v7
    ADD CONSTRAINT cloud_sync_rate_limits_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_snapshots_v7 cloud_sync_snapshots_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_snapshots_v7
    ADD CONSTRAINT cloud_sync_snapshots_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_snapshots_v8 cloud_sync_snapshots_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_snapshots_v8
    ADD CONSTRAINT cloud_sync_snapshots_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_usage_v7 cloud_sync_usage_v7_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_usage_v7
    ADD CONSTRAINT cloud_sync_usage_v7_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_sync_usage_v8 cloud_sync_usage_v8_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_sync_usage_v8
    ADD CONSTRAINT cloud_sync_usage_v8_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: cloud_task_events cloud_task_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_events
    ADD CONSTRAINT cloud_task_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_task_key_access_audits_v6 cloud_task_key_access_audits_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_key_access_audits_v6
    ADD CONSTRAINT cloud_task_key_access_audits_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_task_key_device_envelopes_v6 cloud_task_key_device_envelopes_v6_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_key_device_envelopes_v6
    ADD CONSTRAINT cloud_task_key_device_envelopes_v6_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_task_security_contexts_v5 cloud_task_security_contexts_v5_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_task_security_contexts_v5
    ADD CONSTRAINT cloud_task_security_contexts_v5_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_user_agent_instance_aliases_v3 cloud_user_agent_instance_aliases_v3_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_instance_aliases_v3
    ADD CONSTRAINT cloud_user_agent_instance_aliases_v3_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_user_agent_instances_v3 cloud_user_agent_instances_v3_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_instances_v3
    ADD CONSTRAINT cloud_user_agent_instances_v3_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_user_agent_recruitment_events cloud_user_agent_recruitment_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_agent_recruitment_events
    ADD CONSTRAINT cloud_user_agent_recruitment_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_user_evolution_preferences cloud_user_evolution_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_evolution_preferences
    ADD CONSTRAINT cloud_user_evolution_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_user_market_adoptions cloud_user_market_adoptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_user_market_adoptions
    ADD CONSTRAINT cloud_user_market_adoptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_work_memory_access_audits cloud_work_memory_access_audits_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_access_audits
    ADD CONSTRAINT cloud_work_memory_access_audits_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_work_memory_versions cloud_work_memory_versions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_versions
    ADD CONSTRAINT cloud_work_memory_versions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_work_memory_versions cloud_work_memory_versions_work_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_memory_versions
    ADD CONSTRAINT cloud_work_memory_versions_work_scope_id_fkey FOREIGN KEY (work_scope_id) REFERENCES public.cloud_work_scopes(id) ON DELETE CASCADE;


--
-- Name: cloud_work_participants cloud_work_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_participants
    ADD CONSTRAINT cloud_work_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_work_participants cloud_work_participants_work_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_participants
    ADD CONSTRAINT cloud_work_participants_work_scope_id_fkey FOREIGN KEY (work_scope_id) REFERENCES public.cloud_work_scopes(id) ON DELETE CASCADE;


--
-- Name: cloud_work_scopes cloud_work_scopes_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_work_scopes
    ADD CONSTRAINT cloud_work_scopes_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_files collaboration_files_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_files
    ADD CONSTRAINT collaboration_files_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.agent_delegations(id) ON DELETE CASCADE;


--
-- Name: collaboration_files collaboration_files_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_files
    ADD CONSTRAINT collaboration_files_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_files collaboration_files_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_files
    ADD CONSTRAINT collaboration_files_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_members collaboration_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_members collaboration_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_members
    ADD CONSTRAINT collaboration_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_messages collaboration_group_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_messages
    ADD CONSTRAINT collaboration_group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_messages collaboration_group_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_messages
    ADD CONSTRAINT collaboration_group_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_workspace_files collaboration_group_workspace_files_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspace_files
    ADD CONSTRAINT collaboration_group_workspace_files_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_workspace_files collaboration_group_workspace_files_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspace_files
    ADD CONSTRAINT collaboration_group_workspace_files_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: collaboration_group_workspaces collaboration_group_workspaces_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_group_workspaces
    ADD CONSTRAINT collaboration_group_workspaces_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: collaboration_groups collaboration_groups_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collaboration_groups
    ADD CONSTRAINT collaboration_groups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contact_organization_exit_requests contact_organization_exit_requests_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_exit_requests
    ADD CONSTRAINT contact_organization_exit_requests_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.contact_organizations(id) ON DELETE CASCADE;


--
-- Name: contact_organization_exit_requests contact_organization_exit_requests_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_exit_requests
    ADD CONSTRAINT contact_organization_exit_requests_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contact_organization_exit_requests contact_organization_exit_requests_resolved_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_exit_requests
    ADD CONSTRAINT contact_organization_exit_requests_resolved_by_user_id_fkey FOREIGN KEY (resolved_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contact_organization_members contact_organization_members_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_members
    ADD CONSTRAINT contact_organization_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.contact_organizations(id) ON DELETE CASCADE;


--
-- Name: contact_organization_members contact_organization_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_members
    ADD CONSTRAINT contact_organization_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contact_organization_notices contact_organization_notices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organization_notices
    ADD CONSTRAINT contact_organization_notices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contact_organizations contact_organizations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_organizations
    ADD CONSTRAINT contact_organizations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_memory_documents_v3 fk_cloud_memory_instance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_documents_v3
    ADD CONSTRAINT fk_cloud_memory_instance FOREIGN KEY (user_id, user_agent_instance_id) REFERENCES public.cloud_user_agent_instances_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: cloud_memory_document_versions_v3 fk_cloud_memory_version_document; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_memory_document_versions_v3
    ADD CONSTRAINT fk_cloud_memory_version_document FOREIGN KEY (user_id, memory_document_id) REFERENCES public.cloud_memory_documents_v3(user_id, id) ON DELETE CASCADE;


--
-- Name: friend_requests friend_requests_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: friend_requests friend_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_user_a_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_a_id_fkey FOREIGN KEY (user_a_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_user_b_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_b_id_fkey FOREIGN KEY (user_b_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: large_file_objects large_file_objects_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_objects
    ADD CONSTRAINT large_file_objects_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: large_file_objects large_file_objects_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_objects
    ADD CONSTRAINT large_file_objects_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: large_file_objects large_file_objects_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_objects
    ADD CONSTRAINT large_file_objects_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: large_file_upload_chunks large_file_upload_chunks_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_chunks
    ADD CONSTRAINT large_file_upload_chunks_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.large_file_upload_sessions(id) ON DELETE CASCADE;


--
-- Name: large_file_upload_sessions large_file_upload_sessions_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_sessions
    ADD CONSTRAINT large_file_upload_sessions_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: large_file_upload_sessions large_file_upload_sessions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_sessions
    ADD CONSTRAINT large_file_upload_sessions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: large_file_upload_sessions large_file_upload_sessions_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.large_file_upload_sessions
    ADD CONSTRAINT large_file_upload_sessions_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_contact_remarks social_contact_remarks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_contact_remarks
    ADD CONSTRAINT social_contact_remarks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_contact_remarks social_contact_remarks_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_contact_remarks
    ADD CONSTRAINT social_contact_remarks_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_conversation_preference_commands social_conversation_preference_comman_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preference_commands
    ADD CONSTRAINT social_conversation_preference_comman_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: social_conversation_preference_commands social_conversation_preference_commands_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preference_commands
    ADD CONSTRAINT social_conversation_preference_commands_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_conversation_preferences social_conversation_preferences_account_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preferences
    ADD CONSTRAINT social_conversation_preferences_account_workspace_id_fkey FOREIGN KEY (account_workspace_id) REFERENCES public.account_workspaces(id) ON DELETE CASCADE;


--
-- Name: social_conversation_preferences social_conversation_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_conversation_preferences
    ADD CONSTRAINT social_conversation_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_message_files social_message_files_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_message_files
    ADD CONSTRAINT social_message_files_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.collaboration_groups(id) ON DELETE CASCADE;


--
-- Name: social_message_files social_message_files_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_message_files
    ADD CONSTRAINT social_message_files_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_message_files social_message_files_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_message_files
    ADD CONSTRAINT social_message_files_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_messages social_messages_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_messages
    ADD CONSTRAINT social_messages_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_messages social_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_messages
    ADD CONSTRAINT social_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_realtime_events social_realtime_events_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_realtime_events
    ADD CONSTRAINT social_realtime_events_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_ubuddy_capability_profile_commands social_ubuddy_capability_profile_commands_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_ubuddy_capability_profile_commands
    ADD CONSTRAINT social_ubuddy_capability_profile_commands_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: social_ubuddy_capability_profiles social_ubuddy_capability_profiles_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_ubuddy_capability_profiles
    ADD CONSTRAINT social_ubuddy_capability_profiles_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_presence user_presence_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cloud_evolution_evidence cloud_evidence_api_metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cloud_evidence_api_metadata ON public.cloud_evolution_evidence TO janus_api USING (true) WITH CHECK (true);


--
-- Name: cloud_evolution_evidence cloud_evidence_worker_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cloud_evidence_worker_all ON public.cloud_evolution_evidence TO janus_evolution_worker USING (true) WITH CHECK (true);


--
-- Name: cloud_evolution_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloud_evolution_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO janus_api;
GRANT USAGE ON SCHEMA public TO janus_evolution_worker;
GRANT ALL ON SCHEMA public TO janus_migrator;


--
-- Name: TABLE account_memberships_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_memberships_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_memberships_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_memberships_v8 TO janus_migrator;


--
-- Name: TABLE account_workspace_bindings_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspace_bindings_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_workspace_bindings_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspace_bindings_v8 TO janus_migrator;


--
-- Name: TABLE account_workspace_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspace_memberships TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_workspace_memberships TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspace_memberships TO janus_migrator;


--
-- Name: TABLE account_workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspaces TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_workspaces TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_workspaces TO janus_migrator;


--
-- Name: TABLE accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.accounts TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO janus_migrator;


--
-- Name: TABLE agent_delegation_execution_leases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_execution_leases TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_delegation_execution_leases TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_execution_leases TO janus_migrator;


--
-- Name: TABLE agent_delegation_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_revisions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_delegation_revisions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_revisions TO janus_migrator;


--
-- Name: TABLE agent_delegation_workspace_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_workspace_messages TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_delegation_workspace_messages TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_workspace_messages TO janus_migrator;


--
-- Name: TABLE agent_delegation_workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_workspaces TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_delegation_workspaces TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegation_workspaces TO janus_migrator;


--
-- Name: TABLE agent_delegations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_delegations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_delegations TO janus_migrator;


--
-- Name: TABLE chat_group_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_members TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_group_members TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_members TO janus_migrator;


--
-- Name: TABLE chat_group_message_files; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_message_files TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_group_message_files TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_message_files TO janus_migrator;


--
-- Name: TABLE chat_group_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_messages TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_group_messages TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_messages TO janus_migrator;


--
-- Name: TABLE chat_group_operations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_operations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_group_operations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_group_operations TO janus_migrator;


--
-- Name: TABLE chat_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_groups TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_groups TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_groups TO janus_migrator;


--
-- Name: TABLE chat_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_sessions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.chat_sessions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chat_sessions TO janus_migrator;


--
-- Name: TABLE cloud_agent_cohort_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_cohort_members TO janus_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_cohort_members TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_cohort_members TO janus_migrator;


--
-- Name: TABLE cloud_agent_cohorts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_cohorts TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_cohorts TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_cohorts TO janus_migrator;


--
-- Name: TABLE cloud_agent_context_spaces; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_context_spaces TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_context_spaces TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_context_spaces TO janus_migrator;


--
-- Name: TABLE cloud_agent_context_states; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_context_states TO janus_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_context_states TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_context_states TO janus_migrator;


--
-- Name: TABLE cloud_agent_families_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_families_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_families_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_families_v3 TO janus_migrator;


--
-- Name: TABLE cloud_agent_instance_alias_repairs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_instance_alias_repairs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_instance_alias_repairs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_instance_alias_repairs TO janus_migrator;


--
-- Name: TABLE cloud_agent_leadership_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_evaluations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_leadership_evaluations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_evaluations TO janus_migrator;


--
-- Name: TABLE cloud_agent_leadership_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_leadership_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_events TO janus_migrator;


--
-- Name: TABLE cloud_agent_leadership_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_history TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_leadership_history TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_history TO janus_migrator;


--
-- Name: TABLE cloud_agent_leadership_levels; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_levels TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_leadership_levels TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_leadership_levels TO janus_migrator;


--
-- Name: TABLE cloud_agent_performance_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_performance_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_events TO janus_migrator;


--
-- Name: TABLE cloud_agent_performance_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_history TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_performance_history TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_history TO janus_migrator;


--
-- Name: TABLE cloud_agent_performance_levels; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_levels TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_performance_levels TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_performance_levels TO janus_migrator;


--
-- Name: TABLE cloud_agent_versions_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_versions_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_agent_versions_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_agent_versions_v3 TO janus_migrator;


--
-- Name: TABLE cloud_chat_context_states; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_chat_context_states TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_chat_context_states TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_chat_context_states TO janus_migrator;


--
-- Name: TABLE cloud_cluster_evidence_claims; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_cluster_evidence_claims TO janus_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_cluster_evidence_claims TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_cluster_evidence_claims TO janus_migrator;


--
-- Name: TABLE cloud_cluster_run_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_cluster_run_evidence TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_cluster_run_evidence TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_cluster_run_evidence TO janus_migrator;


--
-- Name: TABLE cloud_conversation_aliases_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_conversation_aliases_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_conversation_aliases_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_conversation_aliases_v7 TO janus_migrator;


--
-- Name: TABLE cloud_conversations_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_conversations_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_conversations_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_conversations_v6 TO janus_migrator;


--
-- Name: TABLE cloud_device_token_nonces_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_device_token_nonces_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_device_token_nonces_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_device_token_nonces_v6 TO janus_migrator;


--
-- Name: TABLE cloud_devices_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_devices_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_devices_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_devices_v6 TO janus_migrator;


--
-- Name: TABLE cloud_effective_skill_projections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_effective_skill_projections TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_effective_skill_projections TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_effective_skill_projections TO janus_migrator;


--
-- Name: TABLE cloud_employee_roster_states; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_employee_roster_states TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_employee_roster_states TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_employee_roster_states TO janus_migrator;


--
-- Name: TABLE cloud_evolution_apply_journals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_apply_journals TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_apply_journals TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_apply_journals TO janus_migrator;


--
-- Name: TABLE cloud_evolution_collection_boundaries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_collection_boundaries TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_collection_boundaries TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_collection_boundaries TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evaluations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evaluations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evaluations TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence TO janus_migrator;
GRANT INSERT ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.evidence_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(evidence_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.owner_user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(owner_user_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.user_agent_instance_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_agent_instance_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.agent_family_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(agent_family_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.source_kind; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source_kind) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.source_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.source_version_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source_version_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.context_space_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(context_space_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.task_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(task_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.delegation_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(delegation_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.content_hash; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(content_hash) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.encryption_algorithm; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(encryption_algorithm) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.key_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(key_id) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.confidence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(confidence) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.privacy_level; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(privacy_level) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.quarantine_reason; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(quarantine_reason) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.occurred_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(occurred_at) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.ingested_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(ingested_at) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.metadata_json; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(metadata_json) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.personal_threshold_eligible; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(personal_threshold_eligible) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.eligibility_policy_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(eligibility_policy_version) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.lineage_key; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(lineage_key) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.validation_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(validation_status) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.validation_policy_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(validation_policy_version) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.validation_json; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(validation_json) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.validated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(validated_at) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.historical_inactive; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(historical_inactive) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.key_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(key_version) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: COLUMN cloud_evolution_evidence.envelope_format; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(envelope_format) ON TABLE public.cloud_evolution_evidence TO janus_api;


--
-- Name: TABLE cloud_evolution_evidence_access_audits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence_access_audits TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_access_audits TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evidence_quarantine; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_quarantine TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence_quarantine TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_quarantine TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evidence_usage; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_usage TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence_usage TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_usage TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evidence_usage_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_usage_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence_usage_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_usage_events TO janus_migrator;


--
-- Name: TABLE cloud_evolution_evidence_validation_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_validation_jobs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_evidence_validation_jobs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_evidence_validation_jobs TO janus_migrator;


--
-- Name: TABLE cloud_evolution_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_jobs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_jobs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_jobs TO janus_migrator;


--
-- Name: TABLE cloud_evolution_key_rotation_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_key_rotation_jobs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_key_rotation_jobs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_key_rotation_jobs TO janus_migrator;


--
-- Name: TABLE cloud_evolution_run_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_run_snapshots TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_run_snapshots TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_run_snapshots TO janus_migrator;


--
-- Name: TABLE cloud_evolution_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_runs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_evolution_runs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_evolution_runs TO janus_migrator;


--
-- Name: TABLE cloud_file_objects_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_file_objects_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_file_objects_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_file_objects_v6 TO janus_migrator;


--
-- Name: TABLE cloud_file_refs_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_file_refs_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_file_refs_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_file_refs_v6 TO janus_migrator;


--
-- Name: TABLE cloud_leadership_appeals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_appeals TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_leadership_appeals TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_appeals TO janus_migrator;


--
-- Name: TABLE cloud_leadership_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_assignments TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_leadership_assignments TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_assignments TO janus_migrator;


--
-- Name: TABLE cloud_leadership_promotion_actions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_promotion_actions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_leadership_promotion_actions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_leadership_promotion_actions TO janus_migrator;


--
-- Name: TABLE cloud_market_adoption_actions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_adoption_actions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_adoption_actions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_adoption_actions TO janus_migrator;


--
-- Name: TABLE cloud_market_agent_candidates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_agent_candidates TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_agent_candidates TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_agent_candidates TO janus_migrator;


--
-- Name: TABLE cloud_market_agent_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_agent_versions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_agent_versions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_agent_versions TO janus_migrator;


--
-- Name: TABLE cloud_market_canary_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_assignments TO janus_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_assignments TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_assignments TO janus_migrator;


--
-- Name: TABLE cloud_market_canary_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_evaluations TO janus_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_evaluations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_evaluations TO janus_migrator;


--
-- Name: TABLE cloud_market_canary_opt_ins; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_opt_ins TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_canary_opt_ins TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_canary_opt_ins TO janus_migrator;


--
-- Name: TABLE cloud_market_candidate_family_sections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_family_sections TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_candidate_family_sections TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_family_sections TO janus_migrator;


--
-- Name: TABLE cloud_market_candidate_privacy_reviews; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_privacy_reviews TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_candidate_privacy_reviews TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_privacy_reviews TO janus_migrator;


--
-- Name: TABLE cloud_market_candidate_section_supports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_section_supports TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_candidate_section_supports TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_section_supports TO janus_migrator;


--
-- Name: TABLE cloud_market_candidate_sections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_sections TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_candidate_sections TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_candidate_sections TO janus_migrator;


--
-- Name: TABLE cloud_market_evaluations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_evaluations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_evaluations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_evaluations TO janus_migrator;


--
-- Name: TABLE cloud_market_version_health; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_version_health TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_version_health TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_version_health TO janus_migrator;


--
-- Name: TABLE cloud_market_version_sections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_version_sections TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_market_version_sections TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_market_version_sections TO janus_migrator;


--
-- Name: TABLE cloud_memory_access_audits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_access_audits TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_memory_access_audits TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_access_audits TO janus_migrator;


--
-- Name: TABLE cloud_memory_document_aliases_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_document_aliases_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_memory_document_aliases_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_document_aliases_v3 TO janus_migrator;


--
-- Name: TABLE cloud_memory_document_versions_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_document_versions_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_memory_document_versions_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_document_versions_v3 TO janus_migrator;


--
-- Name: TABLE cloud_memory_documents_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_documents_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_memory_documents_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_documents_v3 TO janus_migrator;


--
-- Name: TABLE cloud_memory_sync_mappings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_sync_mappings TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_memory_sync_mappings TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_memory_sync_mappings TO janus_migrator;


--
-- Name: TABLE cloud_messages_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_messages_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_messages_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_messages_v6 TO janus_migrator;


--
-- Name: TABLE cloud_model_executions_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_model_executions_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_model_executions_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_model_executions_v6 TO janus_migrator;


--
-- Name: TABLE cloud_performance_backfill_cursors; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_performance_backfill_cursors TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_performance_backfill_cursors TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_performance_backfill_cursors TO janus_migrator;


--
-- Name: TABLE cloud_personal_evolution_actions_v4; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_actions_v4 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_evolution_actions_v4 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_actions_v4 TO janus_migrator;


--
-- Name: TABLE cloud_personal_evolution_memory_operations_v4; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_memory_operations_v4 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_evolution_memory_operations_v4 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_memory_operations_v4 TO janus_migrator;


--
-- Name: TABLE cloud_personal_evolution_proposals_v4; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_proposals_v4 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_evolution_proposals_v4 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_proposals_v4 TO janus_migrator;


--
-- Name: TABLE cloud_personal_evolution_schedule_states; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_schedule_states TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_evolution_schedule_states TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_evolution_schedule_states TO janus_migrator;


--
-- Name: TABLE cloud_personal_skill_overlay_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_skill_overlay_versions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_skill_overlay_versions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_skill_overlay_versions TO janus_migrator;


--
-- Name: TABLE cloud_personal_version_commands; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_version_commands TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_version_commands TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_version_commands TO janus_migrator;


--
-- Name: TABLE cloud_personal_version_health; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_version_health TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_personal_version_health TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_personal_version_health TO janus_migrator;


--
-- Name: TABLE cloud_projects_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_projects_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_projects_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_projects_v6 TO janus_migrator;


--
-- Name: TABLE cloud_sync_batches_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_batches_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_batches_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_batches_v6 TO janus_migrator;


--
-- Name: TABLE cloud_sync_batches_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_batches_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_batches_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_batches_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_changes_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_changes_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_changes_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_changes_v6 TO janus_migrator;


--
-- Name: SEQUENCE cloud_sync_changes_v6_sequence_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v6_sequence_id_seq TO janus_api;
GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v6_sequence_id_seq TO janus_evolution_worker;
GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v6_sequence_id_seq TO janus_migrator;


--
-- Name: TABLE cloud_sync_changes_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_changes_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_changes_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_changes_v8 TO janus_migrator;


--
-- Name: SEQUENCE cloud_sync_changes_v8_sequence_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v8_sequence_id_seq TO janus_api;
GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v8_sequence_id_seq TO janus_evolution_worker;
GRANT SELECT,USAGE ON SEQUENCE public.cloud_sync_changes_v8_sequence_id_seq TO janus_migrator;


--
-- Name: TABLE cloud_sync_compaction_states_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_compaction_states_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_compaction_states_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_compaction_states_v7 TO janus_migrator;


--
-- Name: TABLE cloud_sync_compaction_states_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_compaction_states_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_compaction_states_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_compaction_states_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_conflicts_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_conflicts_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_conflicts_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_conflicts_v6 TO janus_migrator;


--
-- Name: TABLE cloud_sync_conflicts_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_conflicts_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_conflicts_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_conflicts_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_device_cursors_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_device_cursors_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_device_cursors_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_device_cursors_v7 TO janus_migrator;


--
-- Name: TABLE cloud_sync_device_cursors_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_device_cursors_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_device_cursors_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_device_cursors_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_entities_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_entities_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_entities_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_entities_v6 TO janus_migrator;


--
-- Name: TABLE cloud_sync_entities_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_entities_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_entities_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_entities_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_grants TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_grants TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_grants TO janus_migrator;


--
-- Name: TABLE cloud_sync_history_repairs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_history_repairs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_history_repairs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_history_repairs TO janus_migrator;


--
-- Name: TABLE cloud_sync_rate_limits_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_rate_limits_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_rate_limits_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_rate_limits_v7 TO janus_migrator;


--
-- Name: TABLE cloud_sync_snapshots_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_snapshots_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_snapshots_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_snapshots_v7 TO janus_migrator;


--
-- Name: TABLE cloud_sync_snapshots_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_snapshots_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_snapshots_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_snapshots_v8 TO janus_migrator;


--
-- Name: TABLE cloud_sync_usage_v7; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_usage_v7 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_usage_v7 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_usage_v7 TO janus_migrator;


--
-- Name: TABLE cloud_sync_usage_v8; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_usage_v8 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_sync_usage_v8 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_sync_usage_v8 TO janus_migrator;


--
-- Name: TABLE cloud_task_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_events TO janus_migrator;


--
-- Name: TABLE cloud_task_key_access_audits_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_key_access_audits_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_key_access_audits_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_key_access_audits_v6 TO janus_migrator;


--
-- Name: TABLE cloud_task_key_device_envelopes_v6; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_key_device_envelopes_v6 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_key_device_envelopes_v6 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_key_device_envelopes_v6 TO janus_migrator;


--
-- Name: TABLE cloud_task_nodes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_nodes TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_nodes TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_nodes TO janus_migrator;


--
-- Name: TABLE cloud_task_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_runs TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_runs TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_runs TO janus_migrator;


--
-- Name: TABLE cloud_task_security_contexts_v5; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_security_contexts_v5 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_task_security_contexts_v5 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_task_security_contexts_v5 TO janus_migrator;


--
-- Name: TABLE cloud_user_agent_instance_aliases_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_instance_aliases_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_user_agent_instance_aliases_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_instance_aliases_v3 TO janus_migrator;


--
-- Name: TABLE cloud_user_agent_instances_v3; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_instances_v3 TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_user_agent_instances_v3 TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_instances_v3 TO janus_migrator;


--
-- Name: TABLE cloud_user_agent_recruitment_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_recruitment_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_user_agent_recruitment_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_agent_recruitment_events TO janus_migrator;


--
-- Name: TABLE cloud_user_evolution_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_evolution_preferences TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_user_evolution_preferences TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_evolution_preferences TO janus_migrator;


--
-- Name: TABLE cloud_user_market_adoptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_market_adoptions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_user_market_adoptions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_user_market_adoptions TO janus_migrator;


--
-- Name: TABLE cloud_work_memory_access_audits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_memory_access_audits TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_work_memory_access_audits TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_memory_access_audits TO janus_migrator;


--
-- Name: TABLE cloud_work_memory_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_memory_versions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_work_memory_versions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_memory_versions TO janus_migrator;


--
-- Name: TABLE cloud_work_participants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_participants TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_work_participants TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_participants TO janus_migrator;


--
-- Name: TABLE cloud_work_scopes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_scopes TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_work_scopes TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_work_scopes TO janus_migrator;


--
-- Name: TABLE collaboration_files; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_files TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_files TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_files TO janus_migrator;


--
-- Name: TABLE collaboration_group_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_members TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_group_members TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_members TO janus_migrator;


--
-- Name: TABLE collaboration_group_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_messages TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_group_messages TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_messages TO janus_migrator;


--
-- Name: TABLE collaboration_group_workspace_files; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_workspace_files TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_group_workspace_files TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_workspace_files TO janus_migrator;


--
-- Name: TABLE collaboration_group_workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_workspaces TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_group_workspaces TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_group_workspaces TO janus_migrator;


--
-- Name: TABLE collaboration_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_groups TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.collaboration_groups TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collaboration_groups TO janus_migrator;


--
-- Name: TABLE contact_organization_exit_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_exit_requests TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.contact_organization_exit_requests TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_exit_requests TO janus_migrator;


--
-- Name: TABLE contact_organization_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_members TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.contact_organization_members TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_members TO janus_migrator;


--
-- Name: TABLE contact_organization_notices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_notices TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.contact_organization_notices TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organization_notices TO janus_migrator;


--
-- Name: TABLE contact_organizations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organizations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.contact_organizations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contact_organizations TO janus_migrator;


--
-- Name: TABLE email_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_verifications TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.email_verifications TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_verifications TO janus_migrator;


--
-- Name: TABLE friend_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.friend_requests TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.friend_requests TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.friend_requests TO janus_migrator;


--
-- Name: TABLE friendships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.friendships TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.friendships TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.friendships TO janus_migrator;


--
-- Name: TABLE large_file_objects; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_objects TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.large_file_objects TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_objects TO janus_migrator;


--
-- Name: TABLE large_file_upload_chunks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_upload_chunks TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.large_file_upload_chunks TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_upload_chunks TO janus_migrator;


--
-- Name: TABLE large_file_upload_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_upload_sessions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.large_file_upload_sessions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.large_file_upload_sessions TO janus_migrator;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.refresh_tokens TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.refresh_tokens TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.refresh_tokens TO janus_migrator;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.schema_migrations TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.schema_migrations TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.schema_migrations TO janus_migrator;


--
-- Name: TABLE social_contact_remarks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_contact_remarks TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_contact_remarks TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_contact_remarks TO janus_migrator;


--
-- Name: TABLE social_conversation_preference_commands; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_conversation_preference_commands TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_conversation_preference_commands TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_conversation_preference_commands TO janus_migrator;


--
-- Name: TABLE social_conversation_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_conversation_preferences TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_conversation_preferences TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_conversation_preferences TO janus_migrator;


--
-- Name: TABLE social_message_files; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_message_files TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_message_files TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_message_files TO janus_migrator;


--
-- Name: TABLE social_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_messages TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_messages TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_messages TO janus_migrator;


--
-- Name: TABLE social_realtime_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_realtime_events TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_realtime_events TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_realtime_events TO janus_migrator;


--
-- Name: SEQUENCE social_realtime_events_sequence_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.social_realtime_events_sequence_id_seq TO janus_api;
GRANT SELECT,USAGE ON SEQUENCE public.social_realtime_events_sequence_id_seq TO janus_evolution_worker;
GRANT SELECT,USAGE ON SEQUENCE public.social_realtime_events_sequence_id_seq TO janus_migrator;


--
-- Name: TABLE social_ubuddy_capability_profile_commands; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_ubuddy_capability_profile_commands TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_ubuddy_capability_profile_commands TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_ubuddy_capability_profile_commands TO janus_migrator;


--
-- Name: TABLE social_ubuddy_capability_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_ubuddy_capability_profiles TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.social_ubuddy_capability_profiles TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.social_ubuddy_capability_profiles TO janus_migrator;


--
-- Name: TABLE task_node_result_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task_node_result_versions TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.task_node_result_versions TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task_node_result_versions TO janus_migrator;


--
-- Name: TABLE user_blocks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_blocks TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.user_blocks TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_blocks TO janus_migrator;


--
-- Name: TABLE user_presence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_presence TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.user_presence TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_presence TO janus_migrator;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.users TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO janus_migrator;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO janus_api;
ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO janus_evolution_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO janus_migrator;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO janus_api;
ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,INSERT,UPDATE ON TABLES TO janus_evolution_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE janus_migrator_login IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO janus_migrator;


--
--

-- The historical 062_account_workspaces migration seeded this shared
-- personal Workspace before the 076 user trigger began creating account
-- bindings. Keep the data seed in the consolidated baseline so the trigger
-- can safely handle the first registered user on a fresh installation.
INSERT INTO public.account_workspaces(id,workspace_kind,name,status)
VALUES('workspace_personal','personal','个人空间','active')
ON CONFLICT(id) DO UPDATE SET status='active',updated_at=now();

INSERT INTO public.schema_migrations(filename) VALUES ('baseline_sync8_081') ON CONFLICT(filename) DO NOTHING;
