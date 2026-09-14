import type { DesktopActor } from './contracts';

export class ActorRegistry {
  private readonly actors = new Map<string, DesktopActor>();

  register(actor: DesktopActor) {
    if (this.actors.has(actor.summary.name)) {
      throw new Error(`Actor ${actor.summary.name} is already registered`);
    }
    this.actors.set(actor.summary.name, actor);
  }

  get(name: string) {
    return this.actors.get(name) ?? null;
  }

  list() {
    return [...this.actors.values()].map((actor) => actor.summary);
  }
}
