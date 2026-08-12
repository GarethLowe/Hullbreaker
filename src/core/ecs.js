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

  addSystem(fn, order = 0) {
    this.systems.push({ fn, order });
    this.systems.sort((a, b) => a.order - b.order);
  }

  run(ctx) {
    for (const sys of this.systems) {
      sys.fn(ctx);
    }
  }
}
