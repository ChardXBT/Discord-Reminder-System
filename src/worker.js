import { DurableObject } from 'cloudflare:workers';
import { readConfig, scheduleSlot } from './config.js';
import { ReminderEngine } from './reminder.js';

export class Reminder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new ReminderEngine(ctx.storage);
  }

  async check(slot) {
    const config = readConfig(this.env);
    const current = scheduleSlot(config, Date.now());
    if (!current || (config.times.length && current !== slot)) return { status: 'outside-window' };
    return this.engine.run(config, slot);
  }
}

export default {
  async scheduled(controller, env) {
    const config = readConfig(env);
    const slot = scheduleSlot(config, controller.scheduledTime);
    const current = scheduleSlot(config, Date.now());
    if (!slot || !current || (config.times.length && slot !== current)) return;
    const reminder = env.REMINDER.get(env.REMINDER.idFromName('single-channel'));
    const result = await reminder.check(slot);
    console.log('Reminder check', JSON.stringify(result));
    if (result.status === 'needs-review') throw new Error('A Discord delivery needs review; inspect the Durable Object items table');
  },

  fetch() {
    return new Response('Not found', { status: 404 });
  }
};
