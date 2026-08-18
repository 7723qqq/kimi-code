// node/vscode_extension/webview-ui/src/App.tsx
import { useEffect, useState, useCallback } from 'react';
import { isPreflightError } from 'shared/errors';
import type { UIStreamEvent, StreamError, ExtensionConfig } from 'shared/types';

import { ChatArea } from './components/ChatArea';
import { ConfigErrorScreen } from './components/ConfigErrorScreen';
import { Header } from './components/Header';
import { InputArea } from './components/inputarea/InputArea';
import { LoginScreen } from './components/LoginScreen';
import { MCPServersModal } from './components/MCPServersModal';
import { Toaster, toast } from './components/ui/sonner';
import { WorkDirModal } from './components/WorkDirModal';
import { useAppInit, resolveAppView } from './hooks/useAppInit';
import { bridge, Events } from './services';
import { useChatStore, useSettingsStore } from './stores';
import './styles/index.css';

function MainContent({ onAuthAction }: { onAuthAction: () => void }) {
  const { processEvent, startNewConversation, sessionId } = useChatStore();
  const { setMCPServers, setExtensionConfig, extensionConfig } = useSettingsStore();

  useEffect(() => {
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      // Only filter when a session already exists, so session_start is handled normally
      if (
        sessionId &&
        '_sessionId' in event &&
        event._sessionId &&
        event._sessionId !== sessionId
      ) {
        console.log('Ignored stream event from another session:', event._sessionId);
        return;
      }
      processEvent(event);
      if (event.type === 'error') {
        const streamError = event as StreamError;
        if (isPreflightError(streamError.code || 'UNKNOWN')) {
          toast.error(streamError.message);
        }
      }
    });
  }, [processEvent, sessionId]);

  useEffect(() => {
    const unsubs = [
      bridge.on(Events.MCPServersChanged, setMCPServers),
      bridge.on(Events.ExtensionConfigChanged, ({ config }: { config: ExtensionConfig }) =>
        setExtensionConfig(config),
      ),
      bridge.on(Events.FocusInput, () =>
        document.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
      ),
      bridge.on(Events.NewConversation, () => {
        void startNewConversation().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [setMCPServers, setExtensionConfig, startNewConversation]);

  useEffect(() => {
    if (!extensionConfig.enableNewConversationShortcut) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        void startNewConversation().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [extensionConfig.enableNewConversationShortcut, startNewConversation]);

  return (
    <>
      <div className="flex-1 min-h-0 relative group/chat">
        <ChatArea />
      </div>
      <div className="shrink-0 max-h-[80vh] flex flex-col min-h-0">
        <InputArea onAuthAction={onAuthAction} />
      </div>
      <MCPServersModal />
      <WorkDirModal />
    </>
  );
}

export default function App() {
  const { status, errorMessage, modelsCount, refresh } = useAppInit();
  const [skippedLogin, setSkippedLogin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const handleLoginSuccess = useCallback(() => {
    setShowLogin(false);
    setSkippedLogin(false);
    refresh();
  }, [refresh]);

  const handleSkip = useCallback(() => {
    setShowLogin(false);
    setSkippedLogin(true);
  }, []);

  const handleShowLogin = useCallback(() => {
    setSkippedLogin(false);
    setShowLogin(true);
  }, []);

  const handleAuthAction = useCallback(() => {
    setSkippedLogin(false);
    setShowLogin(false);
    refresh();
  }, [refresh]);

  const resolution = resolveAppView({ status, modelsCount, skippedLogin, showLogin });

  // Login screen: not logged in and not skipped, or the user actively chose to log in from another screen
  if (resolution.view === 'login') {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <LoginScreen onLoginSuccess={handleLoginSuccess} onSkip={handleSkip} />
        <Toaster position="top-center" />
      </div>
    );
  }

  // Error and settings status screens; no-models must keep an entry back to the login screen
  if (resolution.view === 'status') {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <ConfigErrorScreen
          type={resolution.status}
          errorMessage={errorMessage}
          onRefresh={refresh}
          onBackToLogin={resolution.canGoToLogin ? handleShowLogin : undefined}
        />
        <Toaster position="top-center" />
      </div>
    );
  }

  // Normal state
  return (
    <div className="flex flex-col h-screen text-foreground overflow-hidden">
      <Header />
      <MainContent onAuthAction={handleAuthAction} />
      <Toaster position="top-center" />
    </div>
  );
}
