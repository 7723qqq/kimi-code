import { describe, expect, it } from 'bun:test';

import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import {
  ASSOCIATIVE_MEMORY_FLAG_ENV,
  ASSOCIATIVE_MEMORY_FLAG_ID,
} from '#/features/associativeMemory/flag';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';

describe('associative memory flag', () => {
  it('uses the experimental env var and a stable flag id', () => {
    expect(ASSOCIATIVE_MEMORY_FLAG_ID).toBe('associative_memory');
    expect(ASSOCIATIVE_MEMORY_FLAG_ENV).toBe('KIMI_CODE_EXPERIMENTAL_ASSOCIATIVE_MEMORY');
  });

  it('registers with the experimental surface and defaults to off', () => {
    const registry = new FlagRegistryService();
    const definition = registry.get(ASSOCIATIVE_MEMORY_FLAG_ID);
    expect(definition?.default).toBe(false);
    expect(definition?.env).toBe(ASSOCIATIVE_MEMORY_FLAG_ENV);
    expect(definition?.surface).toBe('both');
  });
});

describe('associative memory params', () => {
  it('pins the defaults the spec fixes', () => {
    expect(ASSOCIATIVE_MEMORY_PARAMS.maxAtomChars).toBe(400);
    expect(ASSOCIATIVE_MEMORY_PARAMS.contextWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(ASSOCIATIVE_MEMORY_PARAMS.baseLearningRate).toBe(1);
    expect(ASSOCIATIVE_MEMORY_PARAMS.outWeightBudget).toBe(50);
    expect(ASSOCIATIVE_MEMORY_PARAMS.spreadHops).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.spreadDecay).toBe(0.5);
    expect(ASSOCIATIVE_MEMORY_PARAMS.baseK).toBe(5);
    expect(ASSOCIATIVE_MEMORY_PARAMS.computeBudget).toBe(500);
    expect(ASSOCIATIVE_MEMORY_PARAMS.seedTopM).toBe(50);
    expect(ASSOCIATIVE_MEMORY_PARAMS.episodeTopN).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.listLimit).toBe(50);
    expect(ASSOCIATIVE_MEMORY_PARAMS.topK).toBe(8);
    expect(ASSOCIATIVE_MEMORY_PARAMS.activationThreshold).toBe(0.1);
    expect(ASSOCIATIVE_MEMORY_PARAMS.vectorThreshold).toBe(0.3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.clusterCoocThreshold).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.clusterMinSize).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.clusterMaxSize).toBe(20);
    expect(ASSOCIATIVE_MEMORY_PARAMS.loadRef).toBe(10);
    expect(ASSOCIATIVE_MEMORY_PARAMS.conceptFormationRate).toBe(0.5);
    expect(ASSOCIATIVE_MEMORY_PARAMS.powerLawDays).toBe(30);
    expect(ASSOCIATIVE_MEMORY_PARAMS.halfLifeMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ASSOCIATIVE_MEMORY_PARAMS.pruneThreshold).toBe(0.05);
    expect(ASSOCIATIVE_MEMORY_PARAMS.injectionMaxTokens).toBe(600);
    expect(ASSOCIATIVE_MEMORY_PARAMS.supersedeThreshold).toBe(0.9);
    expect(ASSOCIATIVE_MEMORY_PARAMS.maxOutDegree).toBe(12);
    expect(ASSOCIATIVE_MEMORY_PARAMS.heteroFactor).toBe(0.1);
    expect(ASSOCIATIVE_MEMORY_PARAMS.weightDependenceK).toBe(1);
    expect(ASSOCIATIVE_MEMORY_PARAMS.stdpAPlus).toBe(0.5);
    expect(ASSOCIATIVE_MEMORY_PARAMS.stdpAMinus).toBe(1.2);
    expect(ASSOCIATIVE_MEMORY_PARAMS.stdpTau).toBe(1);
    expect(ASSOCIATIVE_MEMORY_PARAMS.bcmGain).toBe(0.3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.cascadeMaxLevel).toBe(4);
    expect(ASSOCIATIVE_MEMORY_PARAMS.cascadeStrength).toBe(0.5);
    expect(ASSOCIATIVE_MEMORY_PARAMS.sleepDownscale).toBe(0.9);
    expect(ASSOCIATIVE_MEMORY_PARAMS.captureCount).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.reconsolidateMergeThreshold).toBe(0.95);
    expect(ASSOCIATIVE_MEMORY_PARAMS.reconsolidateNovelThreshold).toBe(0.2);
    expect(ASSOCIATIVE_MEMORY_PARAMS.interferenceForgetting).toBe(0.95);
    expect(ASSOCIATIVE_MEMORY_PARAMS.replayStrata).toBe(3);
    expect(ASSOCIATIVE_MEMORY_PARAMS.motivatedForgetting).toBe(0.95);
    expect(ASSOCIATIVE_MEMORY_PARAMS.motivatedForgettingMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ASSOCIATIVE_MEMORY_PARAMS.schemaMinHops).toBe(2);
    expect(ASSOCIATIVE_MEMORY_PARAMS.schemaTopK).toBe(8);
    expect(ASSOCIATIVE_MEMORY_PARAMS.schemaTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ASSOCIATIVE_MEMORY_PARAMS.interferenceMaxEdges).toBe(24);
  });
});
