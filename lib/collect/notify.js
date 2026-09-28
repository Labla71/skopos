// Notifier interface: `{ notify(event) }`, resolves when the event is delivered and throws
// otherwise (the collector then keeps the event and retries on the next poll).
//
// Shipped type "command": runs the configured command (argument vector, no shell) once per
// event, with the event as JSON on stdin. Exit 0 means delivered. What the command does with
// it (ticket, mail, chat message) is up to the operator.
import { spawn } from 'node:child_process';

export function commandNotifier({ command, timeout_seconds: timeoutSeconds = 30 }) {
  const [file, ...args] = command;
  return {
    notify(event) {
      return new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'], timeout: timeoutSeconds * 1000 });
        let stderr = '';
        child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
        child.on('error', (e) => reject(new Error(`notifier ${file}: ${e.message}`)));
        child.on('close', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`notifier ${file} ${signal ? `killed by ${signal}` : `exited with ${code}`}: ${stderr.trim().slice(-300)}`));
        });
        child.stdin.on('error', () => {}); // a command that ignores stdin must not crash the collector
        child.stdin.end(`${JSON.stringify(event)}\n`);
      });
    },
  };
}

export function createNotifier(cfg) {
  if (cfg.type === 'command') return commandNotifier(cfg);
  throw new Error(`unknown notifier type ${JSON.stringify(cfg.type)}`);
}
