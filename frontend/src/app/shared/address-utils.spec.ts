import { averageCoinSplit, COIN_MOON_RMAX } from '@app/shared/address-utils';

// Pure-function tests for the coin-moons math. NOTE: the frontend has no unit-test runner
// configured (no karma/jest), so these do not run in CI yet; kept as testable specs.
describe('averageCoinSplit', () => {
  const RMAX = COIN_MOON_RMAX;

  it('healthy: fee much smaller than the mean coin → kept dominates, conserved areas', () => {
    // mean = 1_000_000 sats, feePerInput = 68 * 10 = 680 sats
    const r = averageCoinSplit(1_000_000_000, 1000, 68, 10);
    expect(r).not.toBeNull();
    expect(r.uneconomical).toBe(false);
    expect(r.mean).toBe(1_000_000);
    expect(r.feePerInput).toBe(680);
    expect(r.keptFrac).toBeGreaterThan(0.99);
    expect(r.takenFrac).toBeLessThan(0.01);
    // conservation: rKept² + rFee² ≈ RMAX²
    expect(r.rKept * r.rKept + r.rFee * r.rFee).toBeCloseTo(RMAX * RMAX, 6);
  });

  it('near f*: fee a notable share of the mean, still economical and conserved', () => {
    // mean = 1000 sats, vsize = 100 → f* = 10; pick feerate 9 (just under)
    const r = averageCoinSplit(1_000_000, 1000, 100, 9);
    expect(r.uneconomical).toBe(false);
    expect(r.fStar).toBe(10);
    expect(r.takenFrac).toBeCloseTo(0.9, 6);
    expect(r.keptFrac).toBeCloseTo(0.1, 6);
    expect(r.rKept * r.rKept + r.rFee * r.rFee).toBeCloseTo(RMAX * RMAX, 6);
  });

  it('exactly f*: counts as uneconomical, kept collapses to 0, fee fills the reference coin', () => {
    // feerate === f* === mean / vsize === 1000 / 100 === 10
    const r = averageCoinSplit(1_000_000, 1000, 100, 10);
    expect(r.uneconomical).toBe(true); // boundary: feePerInput === mean → fee eats the whole coin
    expect(r.kept).toBe(0);
    expect(r.keptFrac).toBe(0);
    expect(r.rKept).toBe(0);
    expect(r.rFee).toBeCloseTo(RMAX, 6);
    expect(r.mult).toBeCloseTo(1, 6);
  });

  it('overflow: fee exceeds the mean coin → uneconomical, mult > 1, fee moon maxed', () => {
    // mean = 1000 sats, feePerInput = 100 * 30 = 3000 → 3x the coin
    const r = averageCoinSplit(1_000_000, 1000, 100, 30);
    expect(r.uneconomical).toBe(true);
    expect(r.kept).toBe(0);
    expect(r.mult).toBeCloseTo(3, 6);
    expect(r.takenFrac).toBe(1); // capped
    expect(r.rFee).toBe(RMAX);
    expect(r.rKept).toBe(0);
  });

  it('frozen whale: enormous mean → takenFrac ≈ 0, reads as healthy, no NaN/div-by-zero', () => {
    // mean = 1e12 sats, feePerInput tiny relative to it
    const r = averageCoinSplit(1_000_000_000_000_000, 1000, 68, 5);
    expect(r.uneconomical).toBe(false);
    expect(r.takenFrac).toBeLessThan(0.0015);
    expect(Number.isFinite(r.rKept)).toBe(true);
    expect(Number.isFinite(r.rFee)).toBe(true);
    expect(r.rFee).toBeGreaterThanOrEqual(0);
  });

  it('defensive: unusable aggregates and non-finite feerate return null', () => {
    expect(averageCoinSplit(1_000_000, 0, 68, 10)).toBeNull();      // utxoCount 0
    expect(averageCoinSplit(0, 1000, 68, 10)).toBeNull();           // balance 0
    expect(averageCoinSplit(1_000_000, 1000, 0, 10)).toBeNull();    // vsize 0
    expect(averageCoinSplit(1_000_000, 1000, 68, NaN)).toBeNull();  // feerate absent → NaN
    expect(averageCoinSplit(1_000_000, 1000, 68, undefined as unknown as number)).toBeNull();
  });
});
