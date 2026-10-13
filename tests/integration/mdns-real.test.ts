import { describe, expect, it } from 'vitest';
import { bonjourDriver } from '../../src/main/discovery/bonjour-driver';
import { DiscoveryService } from '../../src/main/discovery/discovery-service';
import { silentLogger } from './helpers';
import { until } from './peer-harness';

// Real multicast is often blocked on CI runners; opt in with MESHTALK_REAL_MDNS=1.
describe.runIf(process.env.MESHTALK_REAL_MDNS === '1')('real mDNS discovery', () => {
  it('two services on this host see each other', async () => {
    const idA = 'A'.repeat(51) + 'B';
    const idB = 'C'.repeat(51) + 'D';
    const a = new DiscoveryService(idA, bonjourDriver, silentLogger());
    const b = new DiscoveryService(idB, bonjourDriver, silentLogger());
    a.start(40001);
    b.start(40002);
    try {
      await until(() => a.get(idB) !== undefined && b.get(idA) !== undefined, 10_000);
      expect(a.get(idB)?.port).toBe(40002);
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 15_000);
});
