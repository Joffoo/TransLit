import assert from 'node:assert/strict';
import {
  API_PROFILES_STORAGE_KEY,
  LEGACY_API_CONFIG_STORAGE_KEY,
  StorageLike,
  createProfile,
  deleteProfile,
  duplicateProfile,
  getActiveProfile,
  getEffectiveApiConfig,
  hasValidApiProfileStore,
  loadApiProfileStore,
  saveApiProfileStore,
  selectProfile,
  updateProfile,
  upsertActiveProfileFromFields,
} from '../services/apiProfileService';

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
  };
}

// 1. Empty storage returns empty store
{
  const storage = createMemoryStorage();
  const store = loadApiProfileStore(storage);
  assert.equal(store.activeProfileId, null);
  assert.equal(store.profiles.length, 0);
  assert.equal(hasValidApiProfileStore(storage), false);
  assert.deepEqual(getEffectiveApiConfig(store), { baseUrl: '', apiKey: '', modelName: '' });
}

// 2. Empty legacy config does not create a junk profile
{
  const storage = createMemoryStorage({
    [LEGACY_API_CONFIG_STORAGE_KEY]: JSON.stringify({ baseUrl: '', apiKey: '  ', modelName: '' }),
  });
  const store = loadApiProfileStore(storage);
  assert.equal(store.profiles.length, 0);
  assert.equal(store.activeProfileId, null);
}

// 3. Non-empty legacy config migrates automatically to '默认配置' and persists
{
  const storage = createMemoryStorage({
    [LEGACY_API_CONFIG_STORAGE_KEY]: JSON.stringify({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-legacy-123',
      modelName: 'gpt-4o-mini',
    }),
  });
  const store = loadApiProfileStore(storage);
  assert.equal(store.profiles.length, 1);
  assert.equal(store.profiles[0].name, '默认配置');
  assert.equal(store.profiles[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(store.profiles[0].apiKey, 'sk-legacy-123');
  assert.equal(store.profiles[0].modelName, 'gpt-4o-mini');
  assert.equal(store.activeProfileId, store.profiles[0].id);
  assert.ok(storage.data[API_PROFILES_STORAGE_KEY], 'migrated store should be persisted');
}

// 4. Corrupted JSON in storage falls back safely without throwing
{
  const storage = createMemoryStorage({
    [API_PROFILES_STORAGE_KEY]: '{not-valid-json',
    [LEGACY_API_CONFIG_STORAGE_KEY]: '{also-broken',
  });
  const store = loadApiProfileStore(storage);
  assert.equal(store.activeProfileId, null);
  assert.equal(store.profiles.length, 0);
  assert.equal(hasValidApiProfileStore(storage), false);
}

// 5. Create, update, duplicate, select, delete, and legacy sync
{
  const storage = createMemoryStorage();
  let store = loadApiProfileStore(storage);

  // Upsert when empty auto-creates a profile
  store = upsertActiveProfileFromFields(store, {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'nvapi-111',
    modelName: 'minimaxai/minimax-m2.1',
  });
  assert.equal(store.profiles.length, 1);
  assert.equal(store.profiles[0].name, '默认配置');
  const firstId = store.profiles[0].id;

  // Create second profile with unique name collision handling
  const created1 = createProfile(store, {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-222',
    modelName: 'gpt-4.1',
  });
  store = created1.store;
  assert.equal(store.profiles.length, 2);
  assert.equal(store.activeProfileId, created1.profile.id);

  const created2 = createProfile(store, { name: 'OpenAI' });
  store = created2.store;
  assert.equal(created2.profile.name, 'OpenAI 2');

  // Duplicate first profile
  const dup = duplicateProfile(store, firstId);
  assert.ok(dup);
  store = dup.store;
  assert.equal(dup.profile.name, '默认配置 (副本)');
  assert.equal(dup.profile.apiKey, 'nvapi-111');
  assert.equal(store.activeProfileId, dup.profile.id);

  // Update active profile
  store = updateProfile(store, dup.profile.id, { modelName: 'deepseek-ai/deepseek-v3.2', name: 'NVIDIA DeepSeek' });
  assert.equal(getActiveProfile(store)?.modelName, 'deepseek-ai/deepseek-v3.2');
  assert.equal(getActiveProfile(store)?.name, 'NVIDIA DeepSeek');

  // Select first profile & save -> legacy key should sync to first profile
  store = selectProfile(store, firstId);
  saveApiProfileStore(store, storage);
  const reloaded = loadApiProfileStore(storage);
  assert.equal(reloaded.activeProfileId, firstId);
  assert.equal(reloaded.profiles.length, 4);
  const syncedLegacy = JSON.parse(storage.data[LEGACY_API_CONFIG_STORAGE_KEY]);
  assert.equal(syncedLegacy.apiKey, 'nvapi-111');
  assert.equal(syncedLegacy.modelName, 'minimaxai/minimax-m2.1');

  // Delete active profile -> falls back to next profile cleanly
  store = deleteProfile(reloaded, firstId);
  assert.equal(store.profiles.length, 3);
  assert.ok(store.activeProfileId);
  assert.notEqual(store.activeProfileId, firstId);

  // Delete remaining profiles -> activeProfileId becomes null
  for (const p of [...store.profiles]) {
    store = deleteProfile(store, p.id);
  }
  assert.equal(store.profiles.length, 0);
  assert.equal(store.activeProfileId, null);
  saveApiProfileStore(store, storage);
  assert.equal(hasValidApiProfileStore(storage), true);
  const emptyLegacy = JSON.parse(storage.data[LEGACY_API_CONFIG_STORAGE_KEY]);
  assert.deepEqual(emptyLegacy, { baseUrl: '', apiKey: '', modelName: '' });
}

console.log('ALL apiProfileService tests passed!');
