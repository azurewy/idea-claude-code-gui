import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpServerSpec } from '../../types/mcp';

interface McpServerDialogProps {
  server?: McpServer | null;
  existingIds?: string[];
  currentProvider?: 'claude' | 'codex' | string;
  onClose: () => void;
  onSave: (server: McpServer) => void;
}

/**
 * 常见占位符模式
 * 用于检测用户配置中是否包含未替换的占位符
 */
const PLACEHOLDER_PATTERNS = [
  'YOUR_',
  'YOUR-',
  'your_',
  'your-',
  'YOUR_API_KEY',
  'YOUR_TOKEN',
  'YOUR_BASE_URL',
  'YOUR_ENDPOINT',
  'REPLACE_WITH',
  'replace_with',
  'YOUR_', // 通用占位符前缀
];

/**
 * 检测字符串中是否包含占位符
 * @param value - 要检测的值
 * @returns 检测到的占位符列表
 */
function detectPlaceholders(value: string): string[] {
  if (!value || typeof value !== 'string') return [];

  const found: string[] = [];
  const lowerValue = value.toLowerCase();

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (lowerValue.includes(pattern.toLowerCase())) {
      found.push(pattern);
    }
  }

  // 检测全大写的值（可能是占位符）
  if (value === value.toUpperCase() && value.length > 5 && /^[A-Z_0-9-]+$/.test(value)) {
    if (!found.includes(value)) {
      found.push(value);
    }
  }

  return found;
}

/**
 * 检测配置对象中的占位符
 * @param config - 配置对象
 * @returns 包含占位符的字段路径和占位符值
 */
function detectConfigPlaceholders(config: any, prefix = ''): Array<{ path: string; placeholder: string }> {
  const results: Array<{ path: string; placeholder: string }> = [];

  if (!config || typeof config !== 'object') return results;

  for (const [key, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      const placeholders = detectPlaceholders(value);
      for (const placeholder of placeholders) {
        results.push({ path, placeholder });
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const itemPath = `${path}[${i}]`;
        if (typeof value[i] === 'string') {
          const placeholders = detectPlaceholders(value[i]);
          for (const placeholder of placeholders) {
            results.push({ path: itemPath, placeholder });
          }
        } else if (typeof value[i] === 'object') {
          results.push(...detectConfigPlaceholders(value[i], itemPath));
        }
      }
    } else if (typeof value === 'object') {
      results.push(...detectConfigPlaceholders(value, path));
    }
  }

  return results;
}

/**
 * MCP Server Configuration Dialog (Add/Edit)
 * Supports both Claude and Codex providers
 */
export function McpServerDialog({ server, existingIds = [], currentProvider = 'claude', onClose, onSave }: McpServerDialogProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  const [saving, setSaving] = useState(false);
  const [jsonContent, setJsonContent] = useState('');
  const [parseError, setParseError] = useState('');
  const [placeholderWarnings, setPlaceholderWarnings] = useState<Array<{ path: string; placeholder: string }>>([]);
  const [showPlaceholderWarning, setShowPlaceholderWarning] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Placeholder examples based on provider
  const claudePlaceholder = `// demo:
// {
//   "mcpServers": {
//     "example-server": {
//       "command": "npx",
//       "args": [
//         "-y",
//         "mcp-server-example"
//       ]
//     }
//   }
// }`;

  const codexPlaceholder = `// Codex MCP Server Example:
// {
//   "mcpServers": {
//     "context7": {
//       "command": "npx",
//       "args": ["-y", "@upstash/context7-mcp"],
//       "env": {
//         "CONTEXT7_API_KEY": "your-api-key"
//       },
//       "startup_timeout_sec": 20,
//       "tool_timeout_sec": 60
//     }
//   }
// }`;

  const placeholder = isCodexMode ? codexPlaceholder : claudePlaceholder;

  // 计算行数
  const lineCount = Math.max((jsonContent || placeholder).split('\n').length, 12);

  // 验证 JSON 是否有效
  const isValid = useCallback(() => {
    if (!jsonContent.trim()) return false;

    // 移除注释行
    const cleanedContent = jsonContent
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');

    if (!cleanedContent.trim()) return false;

    try {
      const parsed = JSON.parse(cleanedContent);
      // 验证结构
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        return Object.keys(parsed.mcpServers).length > 0;
      }
      // 直接是服务器配置 (有 command 或 url)
      if (parsed.command || parsed.url) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [jsonContent]);

  // 处理输入
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonContent(e.target.value);
    setParseError('');
  };

  // 处理 Tab 键
  const handleTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = editorRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      setJsonContent(value.substring(0, start) + '  ' + value.substring(end));

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  // 解析 JSON 配置
  const parseConfig = (): McpServer[] | null => {
    try {
      // 清除之前的占位符警告
      setPlaceholderWarnings([]);

      // 移除注释行
      const cleanedContent = jsonContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');

      const parsed = JSON.parse(cleanedContent);
      const servers: McpServer[] = [];

      // mcpServers 格式
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const [id, config] of Object.entries(parsed.mcpServers)) {
          // Check if ID already exists (except in edit mode)
          if (!server && existingIds.includes(id)) {
            setParseError(t('mcp.serverDialog.errors.idExists', { id }));
            return null;
          }

          const serverConfig = config as any;

          // 检测占位符
          const placeholders = detectConfigPlaceholders(serverConfig, id);
          if (placeholders.length > 0) {
            setPlaceholderWarnings(placeholders);
          }

          // 保留所有原始字段，只设置默认的 type
          const serverSpec = {
            ...serverConfig,
            type: serverConfig.type || (serverConfig.command ? 'stdio' : serverConfig.url ? 'http' : 'stdio'),
          };
          // 移除不属于 server spec 的字段
          delete serverSpec.name;

          const newServer: McpServer = {
            id,
            name: serverConfig.name || id,
            server: serverSpec as McpServerSpec,
            apps: {
              claude: !isCodexMode,
              codex: isCodexMode,
              gemini: false,
            },
            enabled: true,
          };
          servers.push(newServer);
        }
      }
      // 直接服务器配置格式
      else if (parsed.command || parsed.url) {
        const id = `server-${Date.now()}`;
        const serverConfig = parsed;

        // 检测占位符
        const placeholders = detectConfigPlaceholders(serverConfig);
        if (placeholders.length > 0) {
          setPlaceholderWarnings(placeholders);
        }

        // 保留所有原始字段
        const serverSpec = {
          ...parsed,
          type: parsed.type || (parsed.command ? 'stdio' : 'http'),
        };
        // 移除不属于 server spec 的字段
        delete serverSpec.name;

        const newServer: McpServer = {
          id,
          name: parsed.name || id,
          server: serverSpec as McpServerSpec,
          apps: {
            claude: !isCodexMode,
            codex: isCodexMode,
            gemini: false,
          },
          enabled: true,
        };
        servers.push(newServer);
      }

      if (servers.length === 0) {
        setParseError(t('mcp.serverDialog.errors.unrecognizedFormat'));
        return null;
      }

      return servers;
    } catch (e) {
      setParseError(t('mcp.serverDialog.errors.jsonParseError', { message: (e as Error).message }));
      return null;
    }
  };

  // 确认保存
  const handleConfirm = async () => {
    // 如果有占位符警告且还未显示确认对话框，先显示警告
    if (placeholderWarnings.length > 0 && !showPlaceholderWarning) {
      setShowPlaceholderWarning(true);
      return;
    }

    const servers = parseConfig();
    if (!servers) return;

    setSaving(true);
    try {
      // 逐个保存服务器
      for (const srv of servers) {
        onSave(srv);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // 忽略占位符警告并继续保存
  const handleIgnoreWarning = () => {
    setShowPlaceholderWarning(false);
    const servers = parseConfig();
    if (!servers) return;

    setSaving(true);
    try {
      for (const srv of servers) {
        onSave(srv);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // 初始化编辑模式
  useEffect(() => {
    if (server) {
      // 编辑模式：转换为 JSON 格式
      const config: any = {
        mcpServers: {
          [server.id]: {
            ...server.server,
          },
        },
      };
      setJsonContent(JSON.stringify(config, null, 2));
    }
  }, [server]);

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-server-dialog">
        <div className="dialog-header">
          <h3>{server ? t('mcp.serverDialog.editTitle') : t('mcp.serverDialog.addTitle')}</h3>
          <div className="header-actions">
            <button className="mode-btn active">
              {t('mcp.serverDialog.rawConfig')}
            </button>
            <button className="close-btn" onClick={onClose}>
              <span className="codicon codicon-close"></span>
            </button>
          </div>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {t('mcp.serverDialog.description')}
          </p>

          <div className="json-editor">
            <div className="line-numbers">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i + 1} className="line-num">{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={editorRef}
              value={jsonContent}
              className="json-textarea"
              placeholder={placeholder}
              spellCheck="false"
              onChange={handleInput}
              onKeyDown={handleTab}
            />
          </div>

          {parseError && (
            <div className="error-message">
              <span className="codicon codicon-error"></span>
              {parseError}
            </div>
          )}

          {/* 占位符警告 */}
          {placeholderWarnings.length > 0 && !showPlaceholderWarning && (
            <div className="warning-message placeholder-warning">
              <span className="codicon codicon-warning"></span>
              <div className="warning-content">
                <div className="warning-title">{t('mcp.serverDialog.warnings.placeholderDetected')}</div>
                <div className="warning-details">
                  {t('mcp.serverDialog.warnings.placeholderDescription')}
                  <ul className="placeholder-list">
                    {Array.from(new Set(placeholderWarnings.map(w => w.placeholder))).slice(0, 5).map((placeholder, idx) => (
                      <li key={idx}><code>{placeholder}</code></li>
                    ))}
                    {placeholderWarnings.length > 5 && (
                      <li className="more-hint">... {t('mcp.serverDialog.warnings.morePlaceholders', { count: placeholderWarnings.length - 5 })}</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <div className="footer-hint">
            <span className="codicon codicon-info"></span>
            {t('mcp.serverDialog.securityWarning')}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={!isValid() || saving}
            >
              {saving && <span className="codicon codicon-loading codicon-modifier-spin"></span>}
              {saving ? t('mcp.serverDialog.saving') : t('common.confirm')}
            </button>
          </div>
        </div>
      </div>

      {/* 占位符确认对话框 */}
      {showPlaceholderWarning && (
        <div className="dialog-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="dialog confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>
                <span className="codicon codicon-warning"></span>
                {t('mcp.serverDialog.warnings.placeholderConfirmTitle')}
              </h3>
            </div>
            <div className="dialog-body">
              <p>{t('mcp.serverDialog.warnings.placeholderConfirmMessage')}</p>
              <div className="placeholder-details-list">
                {Array.from(new Set(placeholderWarnings.map(w => `${w.path}: ${w.placeholder}`))).slice(0, 8).map((detail, idx) => (
                  <div key={idx} className="placeholder-detail-item">
                    <code>{detail}</code>
                  </div>
                ))}
                {placeholderWarnings.length > 8 && (
                  <div className="placeholder-detail-item more-hint">
                    ... {t('mcp.serverDialog.warnings.morePlaceholders', { count: placeholderWarnings.length - 8 })}
                  </div>
                )}
              </div>
              <p className="confirm-hint">{t('mcp.serverDialog.warnings.placeholderConfirmHint')}</p>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-secondary" onClick={() => setShowPlaceholderWarning(false)}>
                {t('common.back')}
              </button>
              <button className="btn btn-primary" onClick={handleIgnoreWarning}>
                {t('mcp.serverDialog.warnings.saveAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
