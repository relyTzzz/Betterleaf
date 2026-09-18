import { startSimulator } from './server.js';
import type { ProfileName } from './profiles.js';

/**
 * Run both fake devices on the loopback interface.
 *
 * `pnpm sim` gives you an NL22 and an NL29 to point the CLI or the app at, with
 * mDNS advertising on so discovery is exercised for real rather than stubbed.
 */
const advertise = !process.argv.includes('--no-advertise');
const profiles: ProfileName[] = ['NL22', 'NL29'];

// Fixed ports so the CLI can be pointed at them without parsing this output.
// Real devices all sit on 16021 at different addresses; on loopback we need
// different ports instead.
const PORTS: Record<ProfileName, number> = { NL22: 16021, NL29: 16022 };

let sims;
try {
  sims = await Promise.all(
    profiles.map((profile) =>
      startSimulator({
        profile,
        port: PORTS[profile],
        // mDNS announces this machine's LAN address, so the fake device has to
        // actually answer there.
        host: advertise ? '0.0.0.0' : '127.0.0.1',
        advertise,
        pairingOpen: true,
        token: `sim-${profile.toLowerCase()}`,
      }),
    ),
  );
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    console.error(
      `A port (16021/16022) is already in use — another simulator is probably still running.
` +
        'Stop it first, or run with --no-advertise on a machine where 16021/16022 are free.',
    );
  } else {
    console.error(`Could not start the simulator: ${e.message}`);
  }
  process.exit(1);
}

console.log('Betterleaf device simulator\n');
for (const sim of sims) {
  console.log(`  ${sim.info.name}  (${sim.profile.name})`);
  console.log(`    api     ${sim.url}`);
  console.log(`    token   ${sim.token}`);
  console.log(`    stream  udp 127.0.0.1:${sim.streamPort}`);
  console.log(`    mdns    ${advertise ? `_${sim.profile.mdnsType}._tcp` : 'off'}`);
  console.log();
}
console.log('Pairing window is open on both. Ctrl-C to stop.');

const shutdown = async () => {
  await Promise.all(sims.map((s) => s.stop()));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
