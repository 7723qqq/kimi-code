export default {
  chatMessage: {
    forkFromPoint: 'Fork conversation from this point',
    forkConversation: 'Fork Conversation',
    kimi: 'Kimi',
  },
  copyButton: {
    copyMessage: 'Copy message',
  },
  chatStatus: {
    tokenUsage: 'Token Usage',
    context: 'Context',
    input: 'Input',
    output: 'Output',
    contextWindowUsage: 'Context Window Usage',
    totalInputTokens: 'Total Input Tokens',
    outputTokens: 'Output Tokens',
    retry: 'Retry {next}/{max}',
    retryingIn: 'Retrying in {seconds}s: {message}',
  },
  thinking: {
    thinking: 'Thinking',
  },
  header: {
    session: 'Session',
    history: 'History',
    messages: 'Messages',
    startNewConversation: 'Start New Conversation?',
  },
  mcpServers: {
    name: 'Name',
    transport: 'Transport',
    command: 'Command',
    arguments: 'Arguments',
    recommended: 'Recommended',
    cancel: 'Cancel',
    environmentVariables: 'Environment Variables',
    allRecommendedInstalled: 'All recommended servers installed',
    title: 'MCP Servers',
    requiresOauth: 'Requires OAuth',
    addServer: 'Add MCP Server',
    noneConfigured: 'No MCP servers configured',
    deleteTitle: 'Delete MCP Server?',
    deleteWarning: 'This will remove "{name}" from your configuration. This action cannot be undone.',
  },
  workDir: {
    loadFailed: 'Failed to load working directories',
  },
  actionMenu: {
    settings: 'Settings',
    support: 'Support',
    account: 'Account',
  },
  sessionList: {
    deleteConversation: 'Delete Conversation?',
    switchConversation: 'Switch Conversation?',
    searchPlaceholder: 'Search conversations…',
    deleteWarning: 'This will permanently delete this conversation. This action cannot be undone.',
    noResults: 'No conversations found',
    empty: 'No conversations yet',
  },
  streamingConfirm: {
    startNew:
      'The current conversation is still generating a response. Starting a new one will truncate the output. Are you sure you want to continue?',
    switch:
      'The current conversation is still generating a response. Switching will truncate the output. Are you sure you want to continue?',
    generic:
      'The current conversation is still generating a response. This action will truncate the output. Are you sure you want to continue?',
    exitPlanMode:
      'The agent is still working. Exiting plan mode now will affect the current turn. Are you sure you want to exit plan mode immediately?',
  },
  questionDialog: {
    responsePlaceholder: 'Enter your response…',
    selectAll: 'Select all that apply',
    customResponse: 'Custom response…',
  },
  recommendedMcp: {
    playwrightDescription: 'Browser automation and web scraping with headless Chrome',
    context7Description:
      'Up-to-date documentation for any library directly in your prompt',
    githubDescription:
      'Repository management, file operations, and GitHub API integration',
  },
  welcomeHints: {
    quickStartGuide: 'Quick Start Guide',
    mapCodebase: 'Let me map your codebase',
    mapCodebaseDescription: 'Run /init to scan the project and generate docs',
    referenceCode: 'Reference specific code',
    referenceCodeDescription:
      'Type @ to select files, or press Alt+K with code highlighted',
    seeCapabilities: 'See what I can do',
    seeCapabilitiesDescription: 'Type / for all commands—like /compact to trim context',
    deeperAnalysis: 'Need deeper analysis?',
    deeperAnalysisDescription:
      'Enable thinking mode for complex architecture or debugging',
    moreThanCode: 'More than code',
    moreThanCodeDescription:
      "Paste a screenshot or design and I'll help implement it",
    addMoreTools: 'Add more tools',
    addMoreToolsDescription: 'Connect external services via MCP servers in settings',
    fewerInterruptions: 'Prefer fewer interruptions?',
    fewerInterruptionsDescription: 'Enable YOLO mode to auto-approve',
    longContext: 'Context getting long?',
    longContextDescription: 'Type /compact to keep only the essentials',
    guideCommands: 'Commands',
    guideViewCommands: 'View all commands',
    guideScanProject: 'Scan project and generate AGENTS.md file',
    guideTrimContext: 'Trim context so that I focus on the essentials',
    guideTips: 'Tips',
    guideBrowseHistory: 'Browse input history',
    guideAddFiles: 'Add/Search files to reference',
    guideAddSelectedCode: 'Add selected code directly from editor',
    guideProTips: 'Pro Tips',
    guideProYolo: 'Use YOLO mode to auto-approve tool calls',
    guideProAgentsMd: 'AGENTS.md helps me understand your codebase',
    guideProThinking: 'Enable Thinking for complex tasks',
  },
  errors: {
    initFailed: 'Failed to initialize',
    connectionTimeout: 'Connection timed out.',
    sendMessageFailed: 'Unable to send the message.',
  },
  queuedMessages: {
    insertNow: 'Insert now (steer)',
  },
  inputArea: {
    exitPlanMode: 'Exit Plan Mode',
  },
  actionMenuItems: {
    workingDirectory: 'Working Directory',
    mcpServers: 'MCP Servers',
    generalConfig: 'General Config',
    showLogs: 'Show Logs',
    resetKimi: 'Reset Kimi',
  },
  status: {
    loading: 'Loading…',
    processing: 'Processing…',
    searching: 'Searching…',
  },
  configError: {
    modelSetupRequired: 'Model setup required',
    modelSetupHint:
      'Sign in with a Kimi account, or configure a provider and model in your shared Kimi Code config.toml.',
    starting: 'Starting Kimi Code…',
    noWorkspace: 'No workspace open',
    noWorkspaceHint: 'Open a folder to start using Kimi Code.',
    couldNotStart: 'Kimi Code could not start',
    errorDetails: 'Error details',
    sharedConfig: 'Shared Kimi Code configuration',
    sharedConfigHint:
      'VS Code and the terminal UI use the same Kimi Code home, configuration, credentials, and sessions.',
    backToSignIn: 'Back to sign in',
    reload: 'Reload',
    openFolder: 'Open Folder',
    diagnosticsHint:
      'Check the error below. Full diagnostics are available in the Kimi Code output channel.',
    showLogs: 'Show Logs',
    retry: 'Retry',
  },
  fileChanges: {
    none: 'No file changes',
  },
  filePicker: {
    selectMedia: 'Select images or videos…',
    noFiles: 'No files found',
  },
  sessionDetails: {
    title: 'Session Details',
    description: 'Details for this conversation.',
  },
  login: {
    skip: 'Skip',
    subscribe: 'Subscribe',
    waiting: 'Waiting for authentication…',
    browserHint:
      'A browser window should open automatically. Complete the sign-in process there.',
    browserFallback: "If the browser didn't open, visit this URL:",
    openInBrowser: 'Open in browser',
    welcome: 'Welcome to Kimi Code',
    intro: 'Use Kimi Code with your Kimi account subscription or your existing API setup.',
    accountOption: 'Sign in with Kimi Account',
    accountOptionHint: 'Use your Kimi account and Kimi Code subscription.',
    apiOption: 'Use an API key',
    apiOptionHint: 'Use your existing API key configuration.',
    noSubscription:
      'Your account does not have an active Kimi Code subscription. Please subscribe to continue using Kimi Code with your account.',
    subscriptionRequired: 'Subscription Required',
  },
} as const;
