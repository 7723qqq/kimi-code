import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconFileSettings,
  IconFolderOpen,
  IconLoader2,
  IconRefresh,
  IconTerminal2,
} from '@tabler/icons-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { bridge } from '@/services';

import { KimiMascot } from './KimiMascot';

interface Props {
  type: 'loading' | 'runtime-error' | 'no-models' | 'no-workspace';
  errorMessage?: string | null;
  onRefresh?: () => void;
  onBackToLogin?: () => void;
}

function ErrorDetails({ message }: { message?: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!message) return null;

  const copyError = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="bg-muted/50 rounded-lg p-4 text-left space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          <IconTerminal2 className="size-4" />
          <span>{t('configError.errorDetails')}</span>
        </div>
        <Button
          onClick={() => {
            void copyError();
          }}
          variant="ghost"
          size="xs"
          className="h-6 px-1.5 gap-1 shrink-0"
        >
          {copied ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-xs bg-background rounded px-3 py-2 font-mono text-foreground">
        {message}
      </pre>
    </div>
  );
}

function NoModelsContent({ onRefresh, onBackToLogin }: Pick<Props, 'onRefresh' | 'onBackToLogin'>) {
  return (
    <>
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 text-amber-500">
          <IconAlertTriangle className="size-5" />
          <span className="text-sm font-medium">{t('configError.modelSetupRequired')}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('configError.modelSetupHint')}
        </p>
      </div>

      <div className="bg-muted/50 rounded-lg p-4 text-left space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <IconFileSettings className="size-4" />
          {t('configError.sharedConfig')}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('configError.sharedConfigHint')}
        </p>
      </div>

      <div className="flex flex-col min-[400px]:flex-row min-[400px]:justify-between gap-2 w-full">
        {onBackToLogin && (
          <Button
            onClick={onBackToLogin}
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
          >
            <IconArrowLeft className="size-3" />
            {t('configError.backToSignIn')}
          </Button>
        )}
        {onRefresh && (
          <Button
            onClick={onRefresh}
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
          >
            <IconRefresh className="size-3" />
            {t('configError.reload')}
          </Button>
        )}
      </div>
    </>
  );
}

export function ConfigErrorScreen({ type, errorMessage, onRefresh, onBackToLogin }: Props) {
  if (type === 'loading') {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            <span className="text-sm">{t('configError.starting')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'no-workspace') {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-6">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-amber-500">
              <IconFolderOpen className="size-5" />
              <span className="text-sm font-medium">{t('configError.noWorkspace')}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('configError.noWorkspaceHint')}
            </p>
          </div>
          <Button
            onClick={() => {
              void bridge.openFolder();
            }}
            className="gap-2"
          >
            <IconFolderOpen className="size-4" />
            {t('configError.openFolder')}
          </Button>
        </div>
      </div>
    );
  }

  if (type === 'no-models') {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-6">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <NoModelsContent onRefresh={onRefresh} onBackToLogin={onBackToLogin} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div className="max-w-sm mx-auto text-center space-y-6">
        <KimiMascot className="h-10 mx-auto opacity-50" />
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-red-500">
            <IconAlertTriangle className="size-5" />
            <span className="text-sm font-medium">{t('configError.couldNotStart')}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('configError.diagnosticsHint')}
          </p>
        </div>
        <ErrorDetails message={errorMessage} />
        <div className="flex gap-2 justify-center">
          <Button
            onClick={() => {
              void bridge.showLogs();
            }}
            variant="outline"
            size="sm"
          >
            {t('configError.showLogs')}
          </Button>
          {onRefresh && (
            <Button onClick={onRefresh} size="sm" className="gap-1">
              <IconRefresh className="size-3" />
              {t('configError.retry')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
