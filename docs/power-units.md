# Weapon and capacitor units

The power network uses MW and integrates over the fixed simulation step. Because
one MW for one second is one MJ, capacitor storage is measured in MJ:

- `reactor.output`, module `draw`, and capacitor `rate`: MW.
- `capacitor.store`, `Systems.capStore`, and `Systems.capMax`: MJ.
- Beam `weapon.draw`: MW while the beam fires. `Ship.updateWeapons` deducts
  `draw * dt` MJ from the capacitor.
- Discrete-weapon `weapon.draw`: MJ per shot. The firing path deducts it once
  when the projectile is created.
- Projectile `energy`, shield charge, blast energy, and thermal deposition:
  joules. Convert only at a named boundary (`1 MJ = 1e6 J`).

`Ship._canDraw` is an availability gate, not a unit conversion: a charged bank
can pay the requested shot energy, or a live bus may accept the transient. The
following power-network tick still accounts for sustained demand and capacitor
recharge in MW times `dt`.

The overloaded `weapon.draw` name remains for compatibility. A later behavior
change may split it into `powerMW` for beams and `shotEnergyMJ` for discrete
weapons, with explicit simultaneous-fire accounting tests. Do not rebalance
current values as part of that rename.
