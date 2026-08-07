// -----------------------------------------------------------------------------
// ecs.js — a compact, allocation-frugal Entity Component System.
//
// Entities are integer ids. Components are plain objects stored in a per-entity
// Map, with a reverse index (component name -> Set<entityId>) so queries can
// start from the smallest candidate set. Systems are ordered functions.
//
// A ship's *interior* — the module graph, the utility networks, the compartment
// adjacency, the crew roster — is modelled with plain objects rather than
// entities: it is a dense graph walked every tick and gains nothing from
// archetype iteration. Everything at scene scope — ships, projectiles, missiles,
// debris, blasts — lives here.
// -----------------------------------------------------------------------------

export class ECS {
  constructor() {
    this._nextId = 1;
    this.entities = new Map();   // id -> Map<name, component>
    this.index = new Map();      // name -> Set<id>
    this.systems = [];
    this._pendingDestroy = new Set();
    this._destroyHandlers = [];
  }

  // -- lifecycle -------------------------------------------------------------

  create(tag = '') {
    const id = this._nextId++;
    this.entities.set(id, new Map());
    if (tag) {
      this.add(id, 'tag', { name: tag });
    }
    return id;
  }

  destroy(id) {
    if (this.entities.has(id)) {
      this._pendingDestroy.add(id);
    }
  }

  alive(id) {
    return this.entities.has(id) && !this._pendingDestroy.has(id);
  }

  onDestroy(fn) {
    this._destroyHandlers.push(fn);
  }

  /** Applies queued destructions. Call once per frame, after all systems. */
  flush() {
    if (this._pendingDestroy.size === 0) {
      return;
    }
    for (const id of this._pendingDestroy) {
      const comps = this.entities.get(id);
      if (!comps) {
        continue;
      }
      for (const fn of this._destroyHandlers) {
        fn(id, comps);
      }
      for (const name of comps.keys()) {
        const set = this.index.get(name);
        if (set) {
          set.delete(id);
        }
      }
      this.entities.delete(id);
    }
    this._pendingDestroy.clear();
  }

  // -- components ------------------------------------------------------------

  add(id, name, data = {}) {
    const comps = this.entities.get(id);
    if (!comps) {
      return null;
    }
    comps.set(name, data);
    let set = this.index.get(name);
    if (!set) {
      set = new Set();
      this.index.set(name, set);
    }
    set.add(id);
    return data;
  }

  get(id, name) {
    const comps = this.entities.get(id);
    return comps ? comps.get(name) : undefined;
  }

  has(id, name) {
    const comps = this.entities.get(id);
    return !!comps && comps.has(name);
  }

  removeComponent(id, name) {
    const comps = this.entities.get(id);
    if (!comps || !comps.has(name)) {
      return;
    }
    comps.delete(name);
    const set = this.index.get(name);
    if (set) {
      set.delete(id);
    }
  }

  count(name) {
    const set = this.index.get(name);
    return set ? set.size : 0;
  }

  // -- queries ---------------------------------------------------------------

  /**
   * Yields [id, compA, compB, ...] for every live entity holding all `names`.
   * Iteration is driven by the smallest matching index for cheap rejection.
   */
  *query(...names) {
    if (names.length === 0) {
      return;
    }
    let driver = this.index.get(names[0]);
    if (!driver) {
      return;
    }
    for (let i = 1; i < names.length; i++) {
      const set = this.index.get(names[i]);
      if (!set) {
        return;
      }
      if (set.size < driver.size) {
        driver = set;
      }
    }
    // Snapshot: systems routinely spawn/destroy entities while iterating.
    const ids = Array.from(driver);
    for (const id of ids) {
      if (this._pendingDestroy.has(id)) {
        continue;
      }
      const comps = this.entities.get(id);
      if (!comps) {
        continue;
      }
      const out = [id];
      let ok = true;
      for (let i = 0; i < names.length; i++) {
        const c = comps.get(names[i]);
        if (c === undefined) {
          ok = false;
          break;
        }
        out.push(c);
      }
      if (ok) {
        yield out;
      }
    }
  }

  /** First matching entity id, or -1. */
  first(...names) {
    for (const row of this.query(...names)) {
      return row[0];
    }
    return -1;
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
    this.flush();
  }
}
