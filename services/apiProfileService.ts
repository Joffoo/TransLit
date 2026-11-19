import { ApiProfile, ApiProfileStore, AppConfig } from '../types';

export const API_PROFILES_STORAGE_KEY = 'translit_api_profiles';
export const LEGACY_API_CONFIG_STORAGE_KEY = 'translit_api_config';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const getDefaultStorage = (): StorageLike | null => {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
};

const generateProfileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `api_${crypto.randomUUID()}`;
  }
  return `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const ensureUniqueName = (baseName: string, existingNames: string[]): string => {
  const trimmed = baseName.trim() || '新接口配置';
  const nameSet = new Set(existingNames.map((n) => n.trim()));
  if (!nameSet.has(trimmed)) return trimmed;
  let counter = 2;
  while (nameSet.has(`${trimmed} ${counter}`)) {
    counter += 1;
  }
  return `${trimmed} ${counter}`;
};

const normalizeProfile = (raw: any, index: number): ApiProfile | null => {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateProfileId();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : `接口配置 ${index + 1}`;
  return {
    id,
    name,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    modelName: typeof raw.modelName === 'string' ? raw.modelName : '',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
};

export const getActiveProfile = (store: ApiProfileStore): ApiProfile | null => {
  if (!store.profiles.length) return null;
  if (store.activeProfileId) {
    const found = store.profiles.find((p) => p.id === store.activeProfileId);
    if (found) return found;
  }
  return store.profiles[0] ?? null;
};

export const getEffectiveApiConfig = (
  store: ApiProfileStore
): Pick<AppConfig, 'baseUrl' | 'apiKey' | 'modelName'> => {
  const active = getActiveProfile(store);
  if (!active) {
    return { baseUrl: '', apiKey: '', modelName: '' };
  }
  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    modelName: active.modelName,
  };
};

export const saveApiProfileStore = (
  store: ApiProfileStore,
  storage: StorageLike | null = getDefaultStorage()
): void => {
  if (!storage) return;
  const normalizedActiveId =
    store.activeProfileId && store.profiles.some((p) => p.id === store.activeProfileId)
      ? store.activeProfileId
      : store.profiles[0]?.id ?? null;

  const payload: ApiProfileStore = {
    activeProfileId: normalizedActiveId,
    profiles: store.profiles,
  };
  try {
    storage.setItem(API_PROFILES_STORAGE_KEY, JSON.stringify(payload));

    // Keep legacy key in sync with the active profile for backward compatibility
    const effective = getEffectiveApiConfig(payload);
    storage.setItem(LEGACY_API_CONFIG_STORAGE_KEY, JSON.stringify(effective));
  } catch (e) {
    console.error('Failed to save api profiles:', e);
  }
};

export const hasValidApiProfileStore = (
  storage: StorageLike | null = getDefaultStorage()
): boolean => {
  if (!storage) return false;
  const rawProfilesStr = storage.getItem(API_PROFILES_STORAGE_KEY);
  if (!rawProfilesStr) return false;
  try {
    const parsed = JSON.parse(rawProfilesStr);
    return Boolean(parsed && Array.isArray(parsed.profiles));
  } catch {
    return false;
  }
};

export const loadApiProfileStore = (
  storage: StorageLike | null = getDefaultStorage()
): ApiProfileStore => {
  if (!storage) {
    return { activeProfileId: null, profiles: [] };
  }

  const rawProfilesStr = storage.getItem(API_PROFILES_STORAGE_KEY);
  if (rawProfilesStr) {
    try {
      const parsed = JSON.parse(rawProfilesStr);
      if (parsed && Array.isArray(parsed.profiles)) {
        const profiles = parsed.profiles
          .map((item: any, idx: number) => normalizeProfile(item, idx))
          .filter((p: ApiProfile | null): p is ApiProfile => p !== null);

        const activeProfileId =
          typeof parsed.activeProfileId === 'string' &&
          profiles.some((p) => p.id === parsed.activeProfileId)
            ? parsed.activeProfileId
            : profiles[0]?.id ?? null;

        return { activeProfileId, profiles };
      }
    } catch (e) {
      console.error('Failed to parse saved api profiles:', e);
    }
  }

  // Migrate from legacy single-config storage if present and non-empty
  const legacyStr = storage.getItem(LEGACY_API_CONFIG_STORAGE_KEY);
  if (legacyStr) {
    try {
      const legacy = JSON.parse(legacyStr);
      const baseUrl = typeof legacy?.baseUrl === 'string' ? legacy.baseUrl : '';
      const apiKey = typeof legacy?.apiKey === 'string' ? legacy.apiKey : '';
      const modelName = typeof legacy?.modelName === 'string' ? legacy.modelName : '';

      if (baseUrl.trim() || apiKey.trim() || modelName.trim()) {
        const migrated: ApiProfile = {
          id: generateProfileId(),
          name: '默认配置',
          baseUrl,
          apiKey,
          modelName,
          updatedAt: Date.now(),
        };
        const migratedStore: ApiProfileStore = {
          activeProfileId: migrated.id,
          profiles: [migrated],
        };
        saveApiProfileStore(migratedStore, storage);
        return migratedStore;
      }
    } catch (e) {
      console.error('Failed to migrate legacy api config:', e);
    }
  }

  return { activeProfileId: null, profiles: [] };
};

export const createProfile = (
  store: ApiProfileStore,
  input: Partial<Pick<ApiProfile, 'name' | 'baseUrl' | 'apiKey' | 'modelName'>> = {}
): { store: ApiProfileStore; profile: ApiProfile } => {
  const existingNames = store.profiles.map((p) => p.name);
  const name = ensureUniqueName(input.name ?? '新接口配置', existingNames);
  const profile: ApiProfile = {
    id: generateProfileId(),
    name,
    baseUrl: input.baseUrl ?? '',
    apiKey: input.apiKey ?? '',
    modelName: input.modelName ?? '',
    updatedAt: Date.now(),
  };
  const nextStore: ApiProfileStore = {
    activeProfileId: profile.id,
    profiles: [...store.profiles, profile],
  };
  return { store: nextStore, profile };
};

export const updateProfile = (
  store: ApiProfileStore,
  id: string,
  patch: Partial<Pick<ApiProfile, 'name' | 'baseUrl' | 'apiKey' | 'modelName'>>
): ApiProfileStore => {
  let changed = false;
  const profiles = store.profiles.map((p) => {
    if (p.id !== id) return p;
    changed = true;
    return {
      ...p,
      ...patch,
      updatedAt: Date.now(),
    };
  });
  if (!changed) return store;
  return {
    ...store,
    profiles,
  };
};

export const upsertActiveProfileFromFields = (
  store: ApiProfileStore,
  patch: Partial<Pick<ApiProfile, 'name' | 'baseUrl' | 'apiKey' | 'modelName'>>
): ApiProfileStore => {
  const active = getActiveProfile(store);
  if (!active) {
    return createProfile(store, {
      name: patch.name || '默认配置',
      baseUrl: patch.baseUrl ?? '',
      apiKey: patch.apiKey ?? '',
      modelName: patch.modelName ?? '',
    }).store;
  }
  return updateProfile(store, active.id, patch);
};

export const selectProfile = (store: ApiProfileStore, id: string): ApiProfileStore => {
  if (!store.profiles.some((p) => p.id === id)) return store;
  return {
    ...store,
    activeProfileId: id,
  };
};

export const duplicateProfile = (
  store: ApiProfileStore,
  id: string
): { store: ApiProfileStore; profile: ApiProfile } | null => {
  const source = store.profiles.find((p) => p.id === id);
  if (!source) return null;
  return createProfile(store, {
    name: `${source.name} (副本)`,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    modelName: source.modelName,
  });
};

export const deleteProfile = (store: ApiProfileStore, id: string): ApiProfileStore => {
  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return store;
  const remaining = store.profiles.filter((p) => p.id !== id);
  let nextActiveId = store.activeProfileId;
  if (store.activeProfileId === id) {
    const fallback = remaining[idx] ?? remaining[idx - 1] ?? remaining[0] ?? null;
    nextActiveId = fallback ? fallback.id : null;
  }
  return {
    activeProfileId: nextActiveId,
    profiles: remaining,
  };
};
