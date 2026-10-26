/**
 * Scenario: the extension host joins the shared v1 telemetry pipeline under a three-layer consent gate.
 * Responsibilities: initialize the shared client with extension identity, apply the VS Code global
 * telemetry switch dynamically, emit first_launch on device-id minting, and shut down with a short timeout.
 * Wiring: the real composition root; VS Code, kimi-telemetry, oauth, and SDK config/auth boundaries are mocked.
 * Run: cd apps/vscode && bun test --isolate test/telemetry.test.ts
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { installVscode } from './vscode-host';

// The mock factories below run while `../src/telemetry` is being imported, i.e.
// before this module's own top-level statements execute. The shared host object
// is therefore created by a hoisted function so the factories and the tests see
// the same instance.
function createHost() {
  const state = {
    isTelemetryEnabled: true,
    telemetryListener: undefined as ((enabled: boolean) => void) | undefined,
    deviceIdFirstLaunch: false,
    configTelemetry: undefined as boolean | undefined,
    configModel: "kimi-k2",
    accessToken: "token-1" as string | null,
    staticallyEnabled: true,
  };
  return {
    state,
    createKimiDeviceId: mock((_homeDir: string, options?: { onFirstLaunch?: () => void }) => {
      if (state.deviceIdFirstLaunch) options?.onFirstLaunch?.();
      return "device-1";
    }),
    initializeTelemetry: mock(),
    setTelemetryEnabled: mock(),
    shouldEnableTelemetry: mock(() => state.staticallyEnabled),
    track: mock(),
    shutdownTelemetry: mock(async () => undefined),
    installCrashHandlers: mock(),
    resolveKimiRegion: mock(() => "global" as const),
    loadRuntimeConfigSafe: mock(() => ({
      config: {
        telemetry: state.configTelemetry,
        defaultModel: state.configModel,
        providers: {
          "managed:kimi-code": { oauth: { key: "oauth/kimi-code-global", oauthHost: "https://auth.kimi.ai" } },
        },
      },
    })),
    resolveConfigPath: mock(() => "/kimi-home/config.toml"),
    resolveKimiHome: mock(() => "/kimi-home"),
    getCachedAccessToken: mock(async () => state.accessToken),
  };
}

type Host = ReturnType<typeof createHost>;

function host(): Host {
  const holder = host as typeof host & { current?: Host };
  holder.current ??= createHost();
  return holder.current;
}

void mock.module("@moonshot-ai/kimi-telemetry", () => {
  const current = host();
  return {
    initializeTelemetry: current.initializeTelemetry,
    setTelemetryEnabled: current.setTelemetryEnabled,
    shouldEnableTelemetry: current.shouldEnableTelemetry,
    shutdownTelemetry: current.shutdownTelemetry,
    track: current.track,
    installCrashHandlers: current.installCrashHandlers,
  };
});

void mock.module("@moonshot-ai/kimi-code-oauth", () => {
  const current = host();
  return {
    createKimiDeviceId: current.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: "managed:kimi-code",
    KIMI_REGION_PROFILES: {
      "mainland-cn": { telemetryEndpoint: "https://telemetry-logs.example.com/v1/event" },
      global: { telemetryEndpoint: "https://telemetry-logs.example.net/v1/event" },
    },
    resolveKimiRegion: current.resolveKimiRegion,
  };
});

void mock.module("@moonshot-ai/kimi-code-sdk", () => {
  const current = host();
  return {
    KimiAuthFacade: class {
      getCachedAccessToken = current.getCachedAccessToken;
    },
    loadRuntimeConfigSafe: current.loadRuntimeConfigSafe,
    resolveConfigPath: current.resolveConfigPath,
    resolveKimiHome: current.resolveKimiHome,
  };
});

installVscode({
  env: {
    get isTelemetryEnabled() {
      return host().state.isTelemetryEnabled;
    },
    onDidChangeTelemetryEnabled: mock((listener: (enabled: boolean) => void) => {
      host().state.telemetryListener = listener;
      return { dispose: mock() };
    }),
  },
});

import {
  activateExtensionTelemetry,
  deactivateExtensionTelemetry,
} from "../src/telemetry";

const hostApi = host();

function activate() {
  return activateExtensionTelemetry({ version: "1.2.3", log: mock() });
}

function initializeOptions() {
  const call = hostApi.initializeTelemetry.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (call === undefined) throw new Error("initializeTelemetry was not called");
  return call;
}

describe("extension telemetry composition root", () => {
  beforeEach(() => {
    hostApi.state.isTelemetryEnabled = true;
    hostApi.state.telemetryListener = undefined;
    hostApi.state.deviceIdFirstLaunch = false;
    hostApi.state.configTelemetry = undefined;
    hostApi.state.configModel = "kimi-k2";
    hostApi.state.accessToken = "token-1";
    hostApi.state.staticallyEnabled = true;
    mock.clearAllMocks();
  });

  it("initializes the shared stack with extension identity and the config gate", async () => {
    activate();

    const options = initializeOptions();
    expect(options).toMatchObject({
      homeDir: "/kimi-home",
      deviceId: "device-1",
      enabled: true,
      initiallyEnabled: true,
      appName: "kimi-code-vscode",
      version: "1.2.3",
      uiMode: "vscode",
      model: "kimi-k2",
    });
    expect(typeof options["endpoint"]).toBe("function");
    expect(typeof options["getAccessToken"]).toBe("function");
    await expect((options["getAccessToken"] as () => Promise<string | null>)()).resolves.toBe("token-1");
    expect(hostApi.shouldEnableTelemetry).toHaveBeenCalledWith({ enabled: true });
  });

  it("maps config telemetry=false to the static gate", () => {
    hostApi.state.configTelemetry = false;

    activate();

    expect(initializeOptions()["enabled"]).toBe(false);
    expect(hostApi.shouldEnableTelemetry).toHaveBeenCalledWith({ enabled: false });
  });

  it("resolves the endpoint through the region resolver per flush", () => {
    activate();

    const endpoint = initializeOptions()["endpoint"] as () => string;
    expect(endpoint()).toBe("https://telemetry-logs.example.net/v1/event");
    expect(hostApi.resolveKimiRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredOAuthHost: "https://auth.kimi.ai",
        configuredOAuthKey: "oauth/kimi-code-global",
        homeDir: "/kimi-home",
      }),
    );
  });

  it("passes the VS Code global switch as the initial intake state", () => {
    hostApi.state.isTelemetryEnabled = false;

    activate();

    expect(initializeOptions()["initiallyEnabled"]).toBe(false);
    expect(hostApi.setTelemetryEnabled).not.toHaveBeenCalled();
  });

  it("follows live changes of the VS Code global switch", () => {
    activate();
    const listener = hostApi.state.telemetryListener;
    if (listener === undefined) throw new Error("no telemetry listener registered");

    listener(false);
    expect(hostApi.setTelemetryEnabled).toHaveBeenLastCalledWith(false);
    listener(true);
    expect(hostApi.setTelemetryEnabled).toHaveBeenLastCalledWith(true);
  });

  it("ignores live changes when the static gates are closed", () => {
    hostApi.state.staticallyEnabled = false;

    activate();
    hostApi.state.telemetryListener?.(true);

    expect(hostApi.setTelemetryEnabled).not.toHaveBeenCalled();
  });

  it("emits first_launch when the device id is minted", () => {
    hostApi.state.deviceIdFirstLaunch = true;

    activate();

    expect(hostApi.track).toHaveBeenCalledWith("first_launch");
  });

  it("does not emit first_launch for an existing device id", () => {
    activate();

    expect(hostApi.track).not.toHaveBeenCalled();
  });

  it("never installs crash handlers in the shared extension host", () => {
    activate();

    expect(hostApi.installCrashHandlers).not.toHaveBeenCalled();
  });

  it("shuts down with a short timeout on deactivate", async () => {
    await deactivateExtensionTelemetry();

    expect(hostApi.shutdownTelemetry).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });
});
