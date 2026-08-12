// @ts-check

/**
 * @typedef {object} HullSectionDefinition
 * @property {string} id
 * @property {string} label
 * @property {number} volume
 * @property {number} plateHp
 * @property {number} frameHp
 */

/**
 * @typedef {object} LiveSection
 * @property {HullSectionDefinition} def
 * @property {string} id
 * @property {string} label
 * @property {number} plateHp
 * @property {number} plateMax
 * @property {boolean} breached
 * @property {number} breachSize
 * @property {number} frameHp
 * @property {number} frameMax
 * @property {boolean} frameBroken
 * @property {number} atmo
 * @property {number} spill
 * @property {number} fire
 * @property {number} fireSpreadT
 * @property {number} temp
 * @property {boolean} venting
 */

/**
 * @param {HullSectionDefinition} def
 * @param {number} ambientC ship's ambient (AMBIENT_C in systems.js — passed in
 *   rather than imported, which would cycle back through systems.js)
 * @returns {LiveSection}
 */
export function createLiveSection(def, ambientC) {
  return {
    def,
    id: def.id,
    label: def.label,
    plateHp: def.plateHp,
    plateMax: def.plateHp,
    breached: false,
    breachSize: 0,
    frameHp: def.frameHp,
    frameMax: def.frameHp,
    frameBroken: false,
    atmo: 1,
    spill: 0,
    fire: 0,
    fireSpreadT: 0,
    temp: ambientC,
    venting: false,
  };
}

/** @param {HullSectionDefinition} def @param {number} joules */
export function sectionHeatDelta(def, joules) {
  // 900 m³ is the legacy reference compartment; larger rooms heat more slowly.
  return (joules * 4e-5) * (900 / Math.max(def.volume, 1));
}
