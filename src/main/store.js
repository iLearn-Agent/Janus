import { all, run } from './db.js';
import {
  installAgentWorkQueueStoreMethods,
  installAgentAllocationStoreMethods,
  installAccountWorkspaceStoreMethods,
  installAgentDeliveryReceiptStoreMethods,
  installAgentContextStoreMethods,
  installAgentConversationWindowStoreMethods,
  installChatContextStateStoreMethods,
  installEmployeeRecruitmentStoreMethods,
  installEvolutionEvidenceOutboxStoreMethods,
  installMemoryEvolutionStoreMethods,
  installMemoryContextStoreMethods,
  installPersonalEvolutionStoreMethods,
  installTaskOrchestrationStoreMethods,
  installTaskDeliveryReviewStoreMethods,
  installUBuddyCoordinationStoreMethods,
  installUBuddyCapabilityProfileStoreMethods,
  installUBuddyDispatchCommandStoreMethods,
  installUBuddyPlanningStoreMethods,
  installUBuddyPlanningSessionStoreMethods,
  installUserAgentIdentityStoreMethods,
  installWorkspaceConversationStoreMethods,
  installWorkMemoryAccessStoreMethods,
  installWorkDigestStoreMethods,
  installFollowerStoreMethods,
  installAttachedSkillStoreMethods,
} from './modules/persistence/index.js';
import { classifyPrivacy, privateMemoryMarker } from './memory.js';
import { nowIso } from './utils.js';
import { SettingsRepository } from './modules/settings/index.js';
import { LocalTaskMemoryKeyring } from '../shared/taskMemoryCrypto.js';

export class Store {
  constructor(db, { root = '', taskMemoryKeyring = null } = {}) {
    this.db = db;
    this.settings = new SettingsRepository(db);
    this.taskMemoryKeyring = taskMemoryKeyring || new LocalTaskMemoryKeyring({ root });
    this.redactUnsafeMemoryState();
  }

  redactUnsafeMemoryState() {
    const entries = all(this.db, 'SELECT id, memory_type, content, privacy_level FROM memory_entries');
    for (const entry of entries) {
      const detected = classifyPrivacy(entry.content, entry.memory_type);
      const privacy = detected === 'public_reusable' ? entry.privacy_level : detected;
      if (privacy === 'public_reusable') continue;
      const marker = privateMemoryMarker(entry.content, privacy);
      run(
        this.db,
        `UPDATE memory_entries
         SET content = ?, privacy_level = ?, lifecycle_state = 'blocked', updated_at = ?
         WHERE id = ?`,
        [marker, privacy, nowIso(), entry.id],
      );
      const versions = all(this.db, 'SELECT id, old_content, new_content FROM memory_versions WHERE memory_entry_id = ?', [entry.id]);
      for (const version of versions) {
        run(
          this.db,
          'UPDATE memory_versions SET old_content = ?, new_content = ? WHERE id = ?',
          [privateMemoryMarker(version.old_content, privacy), privateMemoryMarker(version.new_content, privacy), version.id],
        );
      }
    }
    const typed = all(this.db, 'SELECT id, memory_type, content, privacy_level FROM typed_memories');
    for (const entry of typed) {
      const detected = classifyPrivacy(entry.content, entry.memory_type);
      const privacy = detected === 'public_reusable' ? entry.privacy_level : detected;
      if (privacy === 'public_reusable') continue;
      run(
        this.db,
        `UPDATE typed_memories
         SET content = ?, privacy_level = ?, status = 'blocked', updated_at = ?
         WHERE id = ?`,
        [privateMemoryMarker(entry.content, privacy), privacy, nowIso(), entry.id],
      );
    }
  }

  settingGet(key, fallback = '') {
    return this.settings.get(key, fallback);
  }

  settingSet(key, value) {
    return this.settings.set(key, value);
  }

  notifyEffectiveSkillChanged(payload = {}) {
    const handler = this.onEffectiveSkillChanged;
    if (typeof handler !== 'function') return;
    queueMicrotask(() => {
      try {
        Promise.resolve(handler(payload)).catch(() => {});
      } catch {}
    });
  }

}

installWorkspaceConversationStoreMethods(Store.prototype);
installAccountWorkspaceStoreMethods(Store.prototype);
installEvolutionEvidenceOutboxStoreMethods(Store.prototype);
installAgentContextStoreMethods(Store.prototype);
installAgentConversationWindowStoreMethods(Store.prototype);
installChatContextStateStoreMethods(Store.prototype);
installWorkMemoryAccessStoreMethods(Store.prototype);
installWorkDigestStoreMethods(Store.prototype);
installFollowerStoreMethods(Store.prototype);
installAttachedSkillStoreMethods(Store.prototype);
installAgentWorkQueueStoreMethods(Store.prototype);
installAgentAllocationStoreMethods(Store.prototype);
installAgentDeliveryReceiptStoreMethods(Store.prototype);
installTaskOrchestrationStoreMethods(Store.prototype);
installTaskDeliveryReviewStoreMethods(Store.prototype);
installUBuddyCoordinationStoreMethods(Store.prototype);
installUBuddyCapabilityProfileStoreMethods(Store.prototype);
installUBuddyDispatchCommandStoreMethods(Store.prototype);
installUBuddyPlanningStoreMethods(Store.prototype);
installUBuddyPlanningSessionStoreMethods(Store.prototype);
installMemoryEvolutionStoreMethods(Store.prototype);
installMemoryContextStoreMethods(Store.prototype);
installUserAgentIdentityStoreMethods(Store.prototype);
installEmployeeRecruitmentStoreMethods(Store.prototype);
installPersonalEvolutionStoreMethods(Store.prototype);
