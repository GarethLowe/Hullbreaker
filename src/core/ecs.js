// -----------------------------------------------------------------------------
// ecs.js — ordered simulation scheduler.
//
// Game owns scene entities directly in its ships and pilots collections. The
// scheduler owns only system order; it deliberately has no entity registry or
// deferred lifecycle queue that could disagree with those collections.
// -----------------------------------------------------------------------------

export class Scheduler {
  constructor() {
    this.systems = [];
  }

  // -- systems ---------------------------------------------------------------

  addSystem(name, fn, order = 0) {
    this.systems.push({ name, fn, order, enabled: true, ms: 0 });
    this.systems.sort((a, b) => a.order - b.order);
  }

  run(ctx) {
    for (const sys of this.systems) {
      if (!sys.enabled) {
        continue;
      }
      sys.fn(ctx);
    }
  }
}
