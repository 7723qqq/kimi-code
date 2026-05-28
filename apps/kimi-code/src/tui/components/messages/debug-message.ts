import { Container, Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '../../theme/colors';

export class DebugMessageComponent extends Container {
  constructor(content: string, colors: ColorPalette) {
    super();
    const prefix = chalk.hex(colors.textMuted).bold('[DEBUG]');
    const body = chalk.hex(colors.textMuted)(content);
    this.addChild(new Text(`  ${prefix} ${body}`, 0, 0));
  }
}
