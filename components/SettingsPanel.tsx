
import React, { useState, useRef, useEffect } from 'react';
import { Settings, BookA, Sparkles, ScanEye, ChevronDown, ChevronRight, Server, Key, Link as LinkIcon, Cpu, PlugZap, CheckCircle2, XCircle, Globe, Check, FileCheck, RefreshCw, Plus, Copy, Trash2, Eye, EyeOff, Tag } from 'lucide-react';
import { ApiProfileStore, AppConfig } from '../types';
import { AiService } from '../services/geminiService';
import { LanguageDetectionSource } from '../services/languageDetectionService';
import {
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

interface SettingsPanelProps {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  disabled: boolean;
  detectedLanguageInfo?: { language: string; source: LanguageDetectionSource } | null;
}

const LANGUAGES = [
  { label: "英语", value: "English" },
  { label: "日语", value: "Japanese" },
  { label: "韩语", value: "Korean" },
  { label: "法语", value: "French" },
  { label: "德语", value: "German" },
  { label: "西班牙语", value: "Spanish" },
  { label: "俄语", value: "Russian" },
  { label: "意大利语", value: "Italian" },
  { label: "葡萄牙语", value: "Portuguese" }
];

const SettingsPanel: React.FC<SettingsPanelProps> = ({ config, setConfig, disabled, detectedLanguageInfo }) => {
  const [showPrompts, setShowPrompts] = useState(false);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [profileStore, setProfileStore] = useState<ApiProfileStore>(() => loadApiProfileStore());
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchMsg, setModelFetchMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [isCustomLangMode, setIsCustomLangMode] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const customLangInputRef = useRef<HTMLInputElement>(null);
  const profileNameInputRef = useRef<HTMLInputElement>(null);
  const testResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (testResetTimerRef.current) {
        clearTimeout(testResetTimerRef.current);
      }
    };
  }, []);

  const activeProfile = getActiveProfile(profileStore);

  useEffect(() => {
    if (
      profileStore.profiles.length === 0 &&
      !hasValidApiProfileStore() &&
      (config.apiKey.trim() || config.baseUrl.trim() || config.modelName.trim())
    ) {
      const seeded = upsertActiveProfileFromFields(profileStore, {
        name: '默认配置',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelName: config.modelName,
      });
      saveApiProfileStore(seeded);
      setProfileStore(seeded);
    }
  }, [config.apiKey, config.baseUrl, config.modelName, profileStore.profiles.length]);

  const isPresetLanguage = LANGUAGES.some(l => l.value === config.sourceLanguage);
  const showCustomInput = isCustomLangMode || !isPresetLanguage;
  const isAutoDetectedCurrent = Boolean(
    detectedLanguageInfo && config.sourceLanguage.trim() === detectedLanguageInfo.language
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(event.target as Node)) {
        setIsLangOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const commitProfileStore = (nextStore: ApiProfileStore, syncConfig = true) => {
    saveApiProfileStore(nextStore);
    setProfileStore(nextStore);
    if (syncConfig) {
      const effective = getEffectiveApiConfig(nextStore);
      setConfig(prev => ({
        ...prev,
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        modelName: effective.modelName,
      }));
    }
  };

  const resetApiTransientState = () => {
    setAvailableModels([]);
    setModelFetchMsg(null);
    setTestStatus('idle');
    setLastError(null);
    setConfirmDeleteId(null);
  };

  const handleSelectProfile = (id: string) => {
    if (!id || id === activeProfile?.id) return;
    const nextStore = selectProfile(profileStore, id);
    commitProfileStore(nextStore, true);
    resetApiTransientState();
  };

  const handleCreateProfile = () => {
    const { store: nextStore } = createProfile(profileStore);
    commitProfileStore(nextStore, true);
    resetApiTransientState();
    setTimeout(() => {
      profileNameInputRef.current?.focus();
      profileNameInputRef.current?.select();
    }, 0);
  };

  const handleDuplicateProfile = () => {
    if (!activeProfile) return;
    const result = duplicateProfile(profileStore, activeProfile.id);
    if (!result) return;
    commitProfileStore(result.store, true);
    setTestStatus('idle');
    setLastError(null);
    setConfirmDeleteId(null);
    setTimeout(() => {
      profileNameInputRef.current?.focus();
      profileNameInputRef.current?.select();
    }, 0);
  };

  const handleDeleteProfile = () => {
    if (!activeProfile) return;
    if (confirmDeleteId !== activeProfile.id) {
      setConfirmDeleteId(activeProfile.id);
      return;
    }
    const nextStore = deleteProfile(profileStore, activeProfile.id);
    commitProfileStore(nextStore, true);
    resetApiTransientState();
  };

  const handleProfileNameChange = (name: string) => {
    const nextStore = activeProfile
      ? updateProfile(profileStore, activeProfile.id, { name })
      : upsertActiveProfileFromFields(profileStore, {
          name,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelName: config.modelName,
        });
    commitProfileStore(nextStore, false);
  };

  const handleChange = (field: keyof AppConfig, value: any) => {
    setConfig(prev => {
      const next = { ...prev, [field]: value };
      if (field === 'enableProofreading' && value === true) {
        next.useRecommendedPrompts = false;
      } else if (field === 'useRecommendedPrompts' && value === true) {
        next.enableProofreading = false;
      }
      return next;
    });
    if (field === 'baseUrl' || field === 'apiKey' || field === 'modelName') {
      const patch = activeProfile
        ? { [field]: value }
        : {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelName: config.modelName,
            [field]: value,
          };
      const nextStore = upsertActiveProfileFromFields(profileStore, patch);
      commitProfileStore(nextStore, false);
      setTestStatus('idle');
      setLastError(null);
      setConfirmDeleteId(null);
    }
    if (field === 'baseUrl' || field === 'apiKey') {
      setModelFetchMsg(null);
    }
  };

  const handleFetchModels = async () => {
      if (!config.apiKey || !config.baseUrl) return;
      setIsFetchingModels(true);
      setModelFetchMsg(null);
      try {
          const service = new AiService(config);
          const models = await service.fetchModels();
          setAvailableModels(models);
          if (models.length === 0) {
              setModelFetchMsg({ type: 'error', text: '接口返回空模型列表，请手动输入模型名称' });
          } else {
              setModelFetchMsg({ type: 'success', text: `已拉取 ${models.length} 个可用模型` });
          }
      } catch (error: any) {
          console.error('Fetch models failed:', error);
          setModelFetchMsg({ type: 'error', text: error?.message || '拉取模型列表失败，请手动输入' });
      } finally {
          setIsFetchingModels(false);
      }
  };

  const handleTestConnection = async () => {
      if (testResetTimerRef.current) {
          clearTimeout(testResetTimerRef.current);
          testResetTimerRef.current = null;
      }
      setTestStatus('testing');
      setLastError(null);
      try {
          const service = new AiService(config);
          await service.testConnection();
          setTestStatus('success');
          testResetTimerRef.current = setTimeout(() => setTestStatus('idle'), 3000);
      } catch (error: any) {
          console.error(error);
          setTestStatus('error');
          setLastError(error.message || "Failed to connect");
      }
  };

  return (
    <div className="bg-white rounded-none border border-black shadow-none overflow-hidden mb-6 transition-all">
      <div className="px-6 py-4 border-b border-black bg-white flex items-center justify-between">
        <div className="flex items-center gap-2.5">
            <Settings className="w-4 h-4 text-black" />
            <h2 className="font-mono text-base font-bold text-black uppercase tracking-widest">翻译设置</h2>
        </div>
      </div>

      <div className="p-5 space-y-6">
        
        {/* --- API Settings Section --- */}
        <div>
            <button
                type="button"
                onClick={() => setShowApiSettings(!showApiSettings)}
                className={`w-full flex items-center justify-between p-3.5 border transition-all text-left font-mono ${
                  showApiSettings 
                    ? 'border-black bg-neutral-50' 
                    : 'border-neutral-300 hover:border-black bg-white'
                }`}
            >
                <div className="flex items-center gap-2.5 flex-1 min-w-0 pr-2">
                    <Server className="w-3.5 h-3.5 text-black shrink-0" />
                    <span className="text-xs font-bold text-black uppercase tracking-wider shrink-0">API 接口配置</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-none font-bold truncate ${
                      config.apiKey 
                        ? 'bg-black text-white' 
                        : 'bg-neutral-100 text-neutral-600 border border-neutral-300'
                    }`}>
                      {config.apiKey 
                        ? (activeProfile
                            ? `${activeProfile.name.trim() || '未命名配置'}${config.modelName ? ` · ${config.modelName}` : ''}`
                            : (config.modelName ? `${config.modelName} · 已配置` : '已配置密钥'))
                        : (activeProfile ? `${activeProfile.name.trim() || '未命名配置'} · 未填密钥` : '未配置 (点击展开)')
                      }
                    </span>
                </div>
                <div className="shrink-0 text-black">
                  {showApiSettings ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
            </button>

            {showApiSettings && (
                <div className="space-y-6 mb-8 animate-in slide-in-from-top-2">
                    <div className="space-y-4 bg-white p-5 rounded-none border border-black shadow-none">
                        {/* Saved API Profiles Bar */}
                        <div className="pb-4 border-b border-neutral-200 space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <label className="text-[10px] font-bold text-black uppercase tracking-widest font-mono">
                                    已保存配置 ({profileStore.profiles.length})
                                </label>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={handleCreateProfile}
                                        disabled={disabled}
                                        className={`flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-1 border border-black bg-black text-white hover:bg-neutral-800 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                                        title="新建空白 API 配置"
                                    >
                                        <Plus className="w-3 h-3" />
                                        <span>新建</span>
                                    </button>
                                    {activeProfile && (
                                        <button
                                            type="button"
                                            onClick={handleDuplicateProfile}
                                            disabled={disabled}
                                            className={`flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-1 border border-black bg-white text-black hover:bg-neutral-100 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                                            title="复制当前配置（保留地址与密钥，便于切换模型）"
                                        >
                                            <Copy className="w-3 h-3" />
                                            <span>复制</span>
                                        </button>
                                    )}
                                    {activeProfile && confirmDeleteId !== activeProfile.id && (
                                        <button
                                            type="button"
                                            onClick={handleDeleteProfile}
                                            disabled={disabled}
                                            className={`flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-1 border border-neutral-300 bg-white text-neutral-700 hover:border-black hover:text-black transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                                            title="删除当前配置"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                            <span>删除</span>
                                        </button>
                                    )}
                                    {activeProfile && confirmDeleteId === activeProfile.id && (
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={handleDeleteProfile}
                                                disabled={disabled}
                                                className="text-[10px] font-mono font-bold px-2 py-1 border border-black bg-black text-white hover:bg-neutral-800 transition-colors"
                                            >
                                                确认删除
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setConfirmDeleteId(null)}
                                                disabled={disabled}
                                                className="text-[10px] font-mono font-bold px-2 py-1 border border-neutral-300 bg-white text-black hover:border-black transition-colors"
                                            >
                                                取消
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {profileStore.profiles.length > 0 ? (
                                <select
                                    aria-label="选择已保存的 API 配置"
                                    value={activeProfile?.id ?? ''}
                                    onChange={(e) => handleSelectProfile(e.target.value)}
                                    disabled={disabled}
                                    className={`w-full px-3 py-2 text-xs rounded-none border border-black focus:ring-0 outline-none font-mono text-black bg-neutral-50 cursor-pointer ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    {profileStore.profiles.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name.trim() || '未命名配置'}
                                            {p.modelName ? ` (${p.modelName})` : ''}
                                            {!p.apiKey ? ' [未填密钥]' : ''}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <p className="text-[10px] text-neutral-500 font-mono">
                                    暂无已保存配置，直接填写下方信息或点击「新建」即可保存多个 API 方案并随时切换。
                                </p>
                            )}
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="flex items-center gap-2 text-[10px] font-bold text-black mb-2 uppercase tracking-widest font-mono">
                                    <Tag className="w-3 h-3"/> 配置名称
                                </label>
                                <input
                                    ref={profileNameInputRef}
                                    type="text"
                                    value={activeProfile?.name ?? ''}
                                    onChange={(e) => handleProfileNameChange(e.target.value)}
                                    onBlur={() => {
                                      if (activeProfile && !activeProfile.name.trim()) {
                                        handleProfileNameChange('未命名配置');
                                      }
                                    }}
                                    disabled={disabled}
                                    placeholder="例如：NVIDIA DeepSeek / OpenAI / 中转站"
                                    className="w-full px-4 py-2.5 text-sm rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-white shadow-none transition-all"
                                />
                            </div>

                            <div>
                                <label className="flex items-center gap-2 text-[10px] font-bold text-black mb-2 uppercase tracking-widest font-mono">
                                    <LinkIcon className="w-3 h-3"/> 接口地址
                                </label>
                                <input
                                    type="text"
                                    value={config.baseUrl}
                                    onChange={(e) => handleChange('baseUrl', e.target.value)}
                                    disabled={disabled}
                                    placeholder="https://integrate.api.nvidia.com/v1"
                                    className="w-full px-4 py-2.5 text-sm rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-white shadow-none transition-all"
                                />
                            </div>
                            
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-2 text-[10px] font-bold text-black uppercase tracking-widest font-mono">
                                        <Cpu className="w-3 h-3"/> 模型名称
                                    </label>
                                    <button
                                        type="button"
                                        onClick={handleFetchModels}
                                        disabled={disabled || isFetchingModels || !config.apiKey || !config.baseUrl}
                                        className={`flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 border border-black bg-white text-black hover:bg-neutral-100 transition-colors ${disabled || isFetchingModels || !config.apiKey || !config.baseUrl ? 'opacity-40 cursor-not-allowed' : ''}`}
                                        title="从接口 GET /models 拉取可用模型"
                                    >
                                        <RefreshCw className={`w-2.5 h-2.5 ${isFetchingModels ? 'animate-spin' : ''}`} />
                                        {isFetchingModels ? '拉取中...' : '拉取模型'}
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    value={config.modelName}
                                    onChange={(e) => handleChange('modelName', e.target.value)}
                                    disabled={disabled}
                                    placeholder="minimaxai/minimax-m2.1"
                                    className="w-full px-4 py-2.5 text-sm rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-white shadow-none transition-all"
                                />
                                {availableModels.length > 0 && (
                                    <select
                                        value={availableModels.includes(config.modelName) ? config.modelName : ''}
                                        onChange={(e) => {
                                            if (e.target.value) handleChange('modelName', e.target.value);
                                        }}
                                        disabled={disabled}
                                        className="mt-2 w-full px-3 py-2 text-xs rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-neutral-50 cursor-pointer"
                                    >
                                        <option value="">-- 从拉取结果中选择模型 ({availableModels.length}) --</option>
                                        {availableModels.map(m => (
                                            <option key={m} value={m}>{m}</option>
                                        ))}
                                    </select>
                                )}
                                {modelFetchMsg && (
                                    <p className={`mt-1.5 text-[10px] font-mono ${modelFetchMsg.type === 'error' ? 'text-red-600' : 'text-neutral-600'}`}>
                                        {modelFetchMsg.text}
                                    </p>
                                )}
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="flex items-center gap-2 text-[10px] font-bold text-black uppercase tracking-widest font-mono">
                                        <Key className="w-3 h-3"/> 接口密钥
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        className="flex items-center gap-1 text-[10px] font-mono text-neutral-600 hover:text-black transition-colors"
                                        title={showApiKey ? '隐藏密钥' : '显示密钥'}
                                    >
                                        {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                        <span>{showApiKey ? '隐藏' : '显示'}</span>
                                    </button>
                                </div>
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    value={config.apiKey}
                                    onChange={(e) => handleChange('apiKey', e.target.value)}
                                    disabled={disabled}
                                    placeholder="请输入接口密钥"
                                    className="w-full px-4 py-2.5 text-sm rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-white shadow-none transition-all"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Test Connection Section - Separated with Divider */}
                    <div className="pt-4 flex flex-col gap-3">
                        <button
                            onClick={handleTestConnection}
                            disabled={disabled || testStatus === 'testing' || !config.apiKey || !config.baseUrl}
                            className={`w-full flex items-center justify-center gap-2 py-3 rounded-none text-xs font-mono font-bold tracking-widest uppercase shadow-none border border-black transition-all
                                ${testStatus === 'success' ? 'bg-white text-black' : 
                                  testStatus === 'error' ? 'bg-black text-white' :
                                  'bg-black text-white hover:bg-neutral-800'
                                } ${disabled || (testStatus === 'testing') || !config.apiKey || !config.baseUrl ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            {testStatus === 'testing' ? <PlugZap className="w-3.5 h-3.5 animate-pulse" /> : 
                             testStatus === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : 
                             testStatus === 'error' ? <XCircle className="w-3.5 h-3.5" /> : 
                             <PlugZap className="w-3.5 h-3.5" />}
                            
                            {testStatus === 'testing' ? '正在测试连接...' : 
                             testStatus === 'success' ? '连接成功' : 
                             testStatus === 'error' ? '连接失败' : 
                             '测试接口连接'}
                        </button>
                        
                        {testStatus === 'error' && lastError && (
                            <div className="text-[10px] text-white bg-black p-3 rounded-none border border-black break-all font-mono leading-relaxed animate-in fade-in">
                                {lastError}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>

        {/* --- Standard Settings --- */}
        
        {/* Source Language */}
        <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-black uppercase tracking-widest font-mono">
                原文语言
              </label>
              {isAutoDetectedCurrent && (
                <span className="text-[10px] font-mono px-2 py-0.5 bg-neutral-100 border border-neutral-300 text-neutral-700">
                  自动识别
                </span>
              )}
            </div>
            <div className="relative" ref={langRef}>
              <button
                type="button"
                onClick={() => !disabled && setIsLangOpen(!isLangOpen)}
                disabled={disabled}
                className={`w-full flex items-center justify-between pl-5 pr-4 py-3.5 bg-white border ${isLangOpen ? 'border-black ring-1 ring-black' : 'border-neutral-300 hover:border-black'} rounded-none text-sm text-black font-mono outline-none transition-all cursor-pointer shadow-none ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-center gap-2.5">
                  <Globe className="w-4 h-4 text-black" />
                  <span>
                    {LANGUAGES.find(l => l.value === config.sourceLanguage)?.label ||
                      (config.sourceLanguage ? `自定义 (${config.sourceLanguage})` : '自定义语言...')}
                  </span>
                </div>
                <ChevronDown className={`w-4 h-4 text-black transition-transform duration-300 ${isLangOpen ? 'rotate-180' : ''}`} />
              </button>

              {isLangOpen && (
                <div className="absolute z-50 w-full mt-2 bg-white border border-black rounded-none shadow-none overflow-hidden animate-in fade-in slide-in-from-top-2">
                  <div className="max-h-64 overflow-y-auto custom-scrollbar py-2">
                    {LANGUAGES.map((lang) => (
                      <button
                        key={lang.value}
                        type="button"
                        onClick={() => {
                          setIsCustomLangMode(false);
                          handleChange('sourceLanguage', lang.value);
                          setIsLangOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-5 py-2.5 text-sm font-mono transition-colors ${!isCustomLangMode && config.sourceLanguage === lang.value ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'}`}
                      >
                        <span>{lang.label}</span>
                        {!isCustomLangMode && config.sourceLanguage === lang.value && <Check className="w-4 h-4 text-white" />}
                      </button>
                    ))}
                    <div className="my-1 border-t border-neutral-200" />
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomLangMode(true);
                        setIsLangOpen(false);
                        setTimeout(() => customLangInputRef.current?.focus(), 0);
                      }}
                      className={`w-full flex items-center justify-between px-5 py-2.5 text-sm font-mono transition-colors ${showCustomInput ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'}`}
                    >
                      <span>自定义语言...</span>
                      {showCustomInput && <Check className="w-4 h-4 text-white" />}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {showCustomInput && (
              <input
                ref={customLangInputRef}
                type="text"
                value={config.sourceLanguage}
                onChange={(e) => handleChange('sourceLanguage', e.target.value)}
                disabled={disabled}
                placeholder="输入原文语言，如：荷兰语、Arabic、拉丁语"
                className="w-full px-4 py-2.5 text-sm rounded-none border border-neutral-300 focus:border-black focus:ring-0 outline-none font-mono text-black bg-white shadow-none transition-all"
              />
            )}
        </div>

          {/* Feature Toggles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-neutral-50 rounded-none border border-neutral-200 shadow-none transition-all">
            <label className="flex items-center gap-3 p-3 rounded-none bg-white border border-neutral-200 hover:border-black shadow-none transition-all cursor-pointer group" title="初译后执行二轮审校润色（与轻量翻译互斥）">
                <div className="relative flex items-center shrink-0">
                    <input 
                        type="checkbox" 
                        checked={config.enableProofreading}
                        onChange={(e) => handleChange('enableProofreading', e.target.checked)}
                        disabled={disabled}
                        className="sr-only"
                    />
                    <div className={`w-9 h-5 border transition-all relative flex items-center p-0.5 ${
                        config.enableProofreading 
                          ? 'bg-black border-black' 
                          : 'bg-neutral-100 border-neutral-300'
                    }`}>
                        <div className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            config.enableProofreading 
                              ? 'translate-x-4 bg-white' 
                              : 'translate-x-0 bg-neutral-400'
                        }`} />
                    </div>
                </div>
                <div className="flex items-center gap-1.5 font-bold text-xs text-black font-mono select-none">
                    <FileCheck className="w-3.5 h-3.5 shrink-0 text-black" />
                    <span>两步翻译</span>
                </div>
            </label>

            <label className="flex items-center gap-3 p-3 rounded-none bg-white border border-neutral-200 hover:border-black shadow-none transition-all cursor-pointer group" title="轻量化单Pass翻译提示词（与两步翻译互斥）">
                <div className="relative flex items-center shrink-0">
                    <input 
                        type="checkbox" 
                        checked={config.useRecommendedPrompts}
                        onChange={(e) => handleChange('useRecommendedPrompts', e.target.checked)}
                        disabled={disabled}
                        className="sr-only"
                    />
                    <div className={`w-9 h-5 border transition-all relative flex items-center p-0.5 ${
                        config.useRecommendedPrompts 
                          ? 'bg-black border-black' 
                          : 'bg-neutral-100 border-neutral-300'
                    }`}>
                        <div className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            config.useRecommendedPrompts 
                              ? 'translate-x-4 bg-white' 
                              : 'translate-x-0 bg-neutral-400'
                        }`} />
                    </div>
                </div>
                <div className="flex items-center gap-1.5 font-bold text-xs text-black font-mono select-none">
                    <Sparkles className="w-3.5 h-3.5 shrink-0 text-black" />
                    <span>轻量翻译</span>
                </div>
            </label>

            <label className="flex items-center gap-3 p-3 rounded-none bg-white border border-neutral-200 hover:border-black shadow-none transition-all cursor-pointer group" title="保持全书术语一致性">
                <div className="relative flex items-center shrink-0">
                    <input 
                        type="checkbox" 
                        checked={config.enableGlossary}
                        onChange={(e) => handleChange('enableGlossary', e.target.checked)}
                        disabled={disabled}
                        className="sr-only"
                    />
                    <div className={`w-9 h-5 border transition-all relative flex items-center p-0.5 ${
                        config.enableGlossary 
                          ? 'bg-black border-black' 
                          : 'bg-neutral-100 border-neutral-300'
                    }`}>
                        <div className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            config.enableGlossary 
                              ? 'translate-x-4 bg-white' 
                              : 'translate-x-0 bg-neutral-400'
                        }`} />
                    </div>
                </div>
                <div className="flex items-center gap-1.5 font-bold text-xs text-black font-mono select-none">
                    <BookA className="w-3.5 h-3.5 shrink-0 text-black" />
                    <span>术语库</span>
                </div>
            </label>

            <label className="flex items-center gap-3 p-3 rounded-none bg-white border border-neutral-200 hover:border-black shadow-none transition-all cursor-pointer group" title="自动识别并跳过扉页、版权页、目录等">
                <div className="relative flex items-center shrink-0">
                    <input 
                        type="checkbox" 
                        checked={config.smartSkip}
                        onChange={(e) => handleChange('smartSkip', e.target.checked)}
                        disabled={disabled}
                        className="sr-only"
                    />
                    <div className={`w-9 h-5 border transition-all relative flex items-center p-0.5 ${
                        config.smartSkip 
                          ? 'bg-black border-black' 
                          : 'bg-neutral-100 border-neutral-300'
                    }`}>
                        <div className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            config.smartSkip 
                              ? 'translate-x-4 bg-white' 
                              : 'translate-x-0 bg-neutral-400'
                        }`} />
                    </div>
                </div>
                <div className="flex items-center gap-1.5 font-bold text-xs text-black font-mono select-none">
                    <ScanEye className="w-3.5 h-3.5 shrink-0 text-black" />
                    <span>智能跳页</span>
                </div>
            </label>
          </div>

        {/* Advanced Prompts Section (Collapsible) */}
        <div className="pt-2">
            <button
                onClick={() => setShowPrompts(!showPrompts)}
                className="flex items-center gap-3 text-xs font-bold text-black hover:text-neutral-600 transition-colors mb-4 focus:outline-none group uppercase tracking-widest w-full font-mono"
            >
                <span>背景设定与补充说明</span>
                <div className="h-px bg-black flex-1 transition-colors" />
                {showPrompts ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>

            {showPrompts && (
                <div className="space-y-6 animate-in slide-in-from-top-2 duration-300">
                    <div className="space-y-2.5">
                        <label className="flex items-center gap-2 text-xs font-bold text-black uppercase tracking-widest font-mono">
                           <BookA className="w-3.5 h-3.5 text-black"/> 书籍背景与翻译要求
                        </label>
                        <p className="text-[10px] text-neutral-500 pb-1 font-mono">
                          填写人名定名、体裁或文风要求，全书生效。
                        </p>
                        <textarea
                            value={config.additionalContext}
                            onChange={(e) => handleChange('additionalContext', e.target.value)}
                            disabled={disabled}
                            placeholder="例如：威廉·吉布森赛博朋克小说，保持硬核文风，将 The Sprawl 译为“蔓延城”。"
                            rows={5}
                            className="w-full px-4 py-3.5 text-xs md:text-sm rounded-none border bg-white border-neutral-300 text-black focus:border-black focus:ring-0 outline-none transition-all font-mono leading-relaxed resize-y shadow-none"
                        />
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;