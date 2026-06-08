/**
 * Tests for the desktop-ipc host config seam (force-HTTP escape hatch).
 * Run with: npx vitest run libs/generic/desktop-ipc/src/config.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureDesktopIpc, isForceHttp } from './config';

const ENV_KEYS = ['DESKTOP_IPC_FORCE_HTTP', 'NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  // Reset host config + restore env so tests don't bleed.
  configureDesktopIpc({ forceHttp: undefined });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('isForceHttp — host config', () => {
  it('defaults to false with no config and no env', () => {
    expect(isForceHttp()).toBe(false);
  });

  it('honors a boolean true/false', () => {
    configureDesktopIpc({ forceHttp: true });
    expect(isForceHttp()).toBe(true);
    configureDesktopIpc({ forceHttp: false });
    expect(isForceHttp()).toBe(false);
  });

  it('honors a lazy resolver, re-evaluated on each check', () => {
    let flag = false;
    configureDesktopIpc({ forceHttp: () => flag });
    expect(isForceHttp()).toBe(false);
    flag = true;
    expect(isForceHttp()).toBe(true);
  });

  it('merges over a previous call rather than replacing the whole config', () => {
    configureDesktopIpc({ forceHttp: true });
    configureDesktopIpc({}); // no forceHttp key → previous value survives
    expect(isForceHttp()).toBe(true);
  });
});

describe('isForceHttp — generic env fallback', () => {
  it('reads DESKTOP_IPC_FORCE_HTTP=1 / =true as true', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    expect(isForceHttp()).toBe(true);
    process.env.DESKTOP_IPC_FORCE_HTTP = 'true';
    expect(isForceHttp()).toBe(true);
  });

  it('treats other env values as false', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '0';
    expect(isForceHttp()).toBe(false);
    process.env.DESKTOP_IPC_FORCE_HTTP = 'yes';
    expect(isForceHttp()).toBe(false);
  });

  it('falls back to the NEXT_PUBLIC_ prefixed var', () => {
    process.env.NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP = '1';
    expect(isForceHttp()).toBe(true);
  });

  it('lets host config take precedence over env', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    configureDesktopIpc({ forceHttp: false });
    expect(isForceHttp()).toBe(false);
  });
});
