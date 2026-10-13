import { Bonjour, type Service } from 'bonjour-service';
import { SERVICE_TYPE, type Announcement, type MdnsDriver } from './discovery-service';

function toAnnouncement(service: Service): Announcement {
  const txt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((service.txt ?? {}) as Record<string, unknown>)) {
    txt[k] = Buffer.isBuffer(v) ? v.toString('utf8') : v;
  }
  return {
    name: service.name,
    host: service.host,
    addresses: service.addresses ?? [],
    port: service.port,
    txt,
  };
}

export function bonjourDriver(): MdnsDriver {
  const bonjour = new Bonjour();
  let browser: ReturnType<Bonjour['find']> | null = null;
  return {
    publish({ name, port, txt }) {
      bonjour.publish({ name, type: SERVICE_TYPE, protocol: 'tcp', port, txt, probe: true });
    },
    browse(onUp, onDown) {
      browser = bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' });
      browser.on('up', (s: Service) => onUp(toAnnouncement(s)));
      browser.on('down', (s: Service) => onDown(toAnnouncement(s)));
    },
    refresh() {
      browser?.update();
    },
    stop() {
      return new Promise((resolve) => {
        browser?.stop();
        bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
      });
    },
  };
}
