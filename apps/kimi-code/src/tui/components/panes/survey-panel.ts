import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import {
  SURVEY_MIN_OPTIONS_WIDTH,
  SURVEY_OPTION_GAP,
  surveyOptionLabels,
  surveyQuestion,
} from '../../constant/survey';
import { currentTheme } from '../../theme';
import type { SurveyResponse } from '../../utils/survey-policy';

export type SurveyPanelPhase = 'open' | 'pending' | 'thanks';

export interface SurveyPanelView {
  phase: SurveyPanelPhase;
  response?: Exclude<SurveyResponse, 'dismissed'>;
  hoverIndex?: number;
}

const DOT = '●';
const DOT_PREFIX_WIDTH = 2;
const OPTION_INDENT = '  ';

function responseLabels(): Record<Exclude<SurveyResponse, 'dismissed'>, string> {
  return {
    bad: t('tui.messages.surveyResponseBad'),
    fine: t('tui.messages.surveyResponseFine'),
    good: t('tui.messages.surveyResponseGood'),
  };
}

export class SurveyPanelComponent implements Component {
  constructor(private readonly view: SurveyPanelView) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [''];
    switch (this.view.phase) {
      case 'open':
        return this.renderOpen(width);
      case 'pending': {
        const label = this.view.response === undefined ? '' : responseLabels()[this.view.response];
        return this.renderStatusLine(
          width,
          currentTheme.fg('textDim', t('tui.messages.surveyFeedbackStatus', { label })),
        );
      }
      case 'thanks':
        return this.renderStatusLine(
          width,
          currentTheme.fg('success', t('tui.messages.surveyThanks')),
        );
    }
  }

  private renderOpen(width: number): string[] {
    const title = wrapTextWithAnsi(surveyQuestion(), Math.max(1, width - DOT_PREFIX_WIDTH)).map(
      (line, index) =>
        (index === 0 ? this.dotPrefix() : ' '.repeat(DOT_PREFIX_WIDTH)) +
        currentTheme.boldFg('textStrong', line),
    );
    const optionsLine = OPTION_INDENT + this.styledOptions();
    if (visibleWidth(optionsLine) <= width) {
      return [...title, optionsLine];
    }
    if (width >= SURVEY_MIN_OPTIONS_WIDTH) {
      return [...title, ...this.styledOptionsPerLine().map((option) => OPTION_INDENT + option)];
    }
    return title;
  }

  private renderStatusLine(width: number, styledText: string): string[] {
    return [truncateToWidth(this.dotPrefix() + styledText, width)];
  }

  private dotPrefix(): string {
    return currentTheme.fg('accent', DOT) + ' ';
  }

  private styledOptions(): string {
    return surveyOptionLabels()
      .map((label, index) => this.styleOption(label, index))
      .join(' '.repeat(SURVEY_OPTION_GAP));
  }

  private styledOptionsPerLine(): string[] {
    return surveyOptionLabels().map((label, index) => this.styleOption(label, index));
  }

  private styleOption(label: string, index: number): string {
    if (this.view.hoverIndex === index) {
      return currentTheme.bg('border', currentTheme.boldFg('textStrong', label));
    }
    return currentTheme.fg('text', label);
  }
}
