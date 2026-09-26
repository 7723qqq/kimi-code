import { useState, useEffect, useMemo } from 'react';

import { t } from '@/i18n';
import { bridge } from '@/services';

export interface WelcomeHint {
  title: string;
  description: string;
  slashCommand?: string;
  component?: React.ReactNode;
}

function ShortcutRow({ kbd, children }: { kbd: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-3">
      <kbd className="kbd shrink-0">{kbd}</kbd>
      <span className="text-right">{children}</span>
    </div>
  );
}

function ShortcutGuide() {
  return (
    <div className="text-left text-xs mt-2 space-y-5 w-full max-w-96">
      <div>
        <div className="font-medium text-foreground mb-1.5">⚡ {t('welcomeHints.guideCommands')}</div>
        <div className="text-muted-foreground space-y-1">
          <ShortcutRow kbd="/">{t('welcomeHints.guideViewCommands')}</ShortcutRow>
          <ShortcutRow kbd="/init">{t('welcomeHints.guideScanProject')}</ShortcutRow>
          <ShortcutRow kbd="/compact">{t('welcomeHints.guideTrimContext')}</ShortcutRow>
        </div>
      </div>
      <div>
        <div className="font-medium text-foreground mb-1.5">💡 {t('welcomeHints.guideTips')}</div>
        <div className="text-muted-foreground space-y-1">
          <ShortcutRow kbd="↑">{t('welcomeHints.guideBrowseHistory')}</ShortcutRow>
          <ShortcutRow kbd="@">{t('welcomeHints.guideAddFiles')}</ShortcutRow>
          <ShortcutRow kbd="Alt+K">{t('welcomeHints.guideAddSelectedCode')}</ShortcutRow>
        </div>
      </div>
      <div>
        <div className="font-medium text-foreground mb-1.5">🚀 {t('welcomeHints.guideProTips')}</div>
        <div className="text-muted-foreground space-y-1">
          <div>• {t('welcomeHints.guideProYolo')}</div>
          <div>• {t('welcomeHints.guideProAgentsMd')}</div>
          <div>• {t('welcomeHints.guideProThinking')}</div>
        </div>
      </div>
    </div>
  );
}

// Built per call, not at module scope: `t()` has to run under the active
// locale, and a module-level constant would freeze whichever locale happened
// to be installed when the bundle was first evaluated.
function hintsPool(): WelcomeHint[] {
  return [
    {
      title: t('welcomeHints.quickStartGuide'),
      description: '',
      component: <ShortcutGuide />,
    },
    {
      title: t('welcomeHints.mapCodebase'),
      description: t('welcomeHints.mapCodebaseDescription'),
      slashCommand: '/init',
    },
    {
      title: t('welcomeHints.referenceCode'),
      description: t('welcomeHints.referenceCodeDescription'),
    },
    {
      title: t('welcomeHints.seeCapabilities'),
      description: t('welcomeHints.seeCapabilitiesDescription'),
    },
    {
      title: t('welcomeHints.deeperAnalysis'),
      description: t('welcomeHints.deeperAnalysisDescription'),
    },
    {
      title: t('welcomeHints.moreThanCode'),
      description: t('welcomeHints.moreThanCodeDescription'),
    },
    {
      title: t('welcomeHints.addMoreTools'),
      description: t('welcomeHints.addMoreToolsDescription'),
    },
    {
      title: t('welcomeHints.fewerInterruptions'),
      description: t('welcomeHints.fewerInterruptionsDescription'),
    },
    {
      title: t('welcomeHints.longContext'),
      description: t('welcomeHints.longContextDescription'),
      slashCommand: '/compact',
    },
  ];
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function withProbability(p: number): boolean {
  return Math.random() < p;
}

export function useWelcomeHint(): WelcomeHint {
  const [hasAgentMd, setHasAgentMd] = useState<boolean | null>(null);
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);

  useEffect(() => {
    bridge
      .checkFileExists('AGENT.md')
      .then(setHasAgentMd)
      .catch(() => setHasAgentMd(false));
    bridge
      .getKimiSessions()
      .then((s) => setHasHistory(s.length > 0))
      .catch(() => setHasHistory(false));
  }, []);

  return useMemo(() => {
    const pool = hintsPool();
    // First time user: show shortcut guide
    if (hasHistory === false) {
      return pool[0]!;
    }
    // 30% chance to show AGENT.md hint if missing
    if (hasAgentMd === false && withProbability(0.3)) {
      return pool[1]!;
    }
    return pickRandom(pool);
  }, [hasAgentMd, hasHistory]);
}
