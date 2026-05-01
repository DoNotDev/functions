import { describe, it, expect } from 'vitest';

import { calculateCost } from '../costTracker';

describe('Server-side calculateCost', () => {
  it('calculates claude-sonnet-4 cost correctly', () => {
    const result = calculateCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      },
      'claude-sonnet-4-20250514',
      4.0
    );

    expect(result.providerCost).toBeCloseTo(18.0);
    expect(result.billedCost).toBeCloseTo(72.0);
    expect(result.markup).toBe(4.0);
  });

  it('calculates gpt-4o cost correctly', () => {
    const result = calculateCost(
      {
        promptTokens: 500_000,
        completionTokens: 100_000,
        totalTokens: 600_000,
      },
      'gpt-4o',
      4.0
    );

    // 0.5M * $2.50/M = $1.25 prompt
    // 0.1M * $10.00/M = $1.00 completion
    // total = $2.25 provider, $9.00 billed
    expect(result.providerCost).toBeCloseTo(2.25);
    expect(result.billedCost).toBeCloseTo(9.0);
  });

  it('calculates gemini-2.5-pro cost correctly', () => {
    const result = calculateCost(
      { promptTokens: 100_000, completionTokens: 50_000, totalTokens: 150_000 },
      'gemini-2.5-pro',
      4.0
    );

    // 0.1M * $1.25/M = $0.125 prompt
    // 0.05M * $10.00/M = $0.50 completion
    // total = $0.625 provider, $2.50 billed
    expect(result.providerCost).toBeCloseTo(0.625);
    expect(result.billedCost).toBeCloseTo(2.5);
  });

  it('uses default markup of 4.0', () => {
    const result = calculateCost(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      'claude-haiku-4-5-20251001'
    );

    // $0.80 * 4 = $3.20
    expect(result.providerCost).toBeCloseTo(0.8);
    expect(result.billedCost).toBeCloseTo(3.2);
  });

  it('throws for unknown model', () => {
    expect(() =>
      calculateCost(
        { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        'imaginary-model-9000'
      )
    ).toThrow('Unknown model for cost calculation: imaginary-model-9000');
  });

  it('handles zero usage', () => {
    const result = calculateCost(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      'gpt-4o-mini'
    );

    expect(result.providerCost).toBe(0);
    expect(result.billedCost).toBe(0);
    expect(result.breakdown.promptCost).toBe(0);
    expect(result.breakdown.completionCost).toBe(0);
  });

  it('returns correct breakdown', () => {
    const result = calculateCost(
      {
        promptTokens: 2_000_000,
        completionTokens: 500_000,
        totalTokens: 2_500_000,
      },
      'gpt-4.1',
      5.0
    );

    // 2M * $2.00/M = $4.00 prompt
    // 0.5M * $8.00/M = $4.00 completion
    expect(result.breakdown.promptTokens).toBe(2_000_000);
    expect(result.breakdown.completionTokens).toBe(500_000);
    expect(result.breakdown.promptCost).toBeCloseTo(4.0);
    expect(result.breakdown.completionCost).toBeCloseTo(4.0);
    expect(result.providerCost).toBeCloseTo(8.0);
    expect(result.billedCost).toBeCloseTo(40.0);
    expect(result.markup).toBe(5.0);
  });

  it('pricing is consistent between all supported models', () => {
    const models = [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-20250514',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'o3-mini',
      'gemini-2.0-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ];

    for (const model of models) {
      const result = calculateCost(
        { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        model
      );
      expect(result.providerCost).toBeGreaterThanOrEqual(0);
      expect(result.billedCost).toBeGreaterThanOrEqual(result.providerCost);
      expect(result.markup).toBe(4.0);
    }
  });
});
