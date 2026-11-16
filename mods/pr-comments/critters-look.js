// The critters look, as published by the herdr-critters mod (shared "critters.look").
// Mods can't import each other's files, so any mod that wants to match copies this
// small file. Colors come from theme(): Herdr's theme is the matching critters-<id>.

import { shared, machines } from "herdr";

export const LOOK_KEY = "critters.look";

// The active look, or null until herdr-critters has published one (draw plain then).
export const critters = () => shared(LOOK_KEY) ?? null;

// A machine's scene, in the same order the agents list uses: this computer gets the
// local scene, other machines take the remote scenes in turn.
export function sceneFor(look, machine) {
  if (!machine) return { id: look.localScene, ...look.scenes[look.localScene] };
  const order = machines().map((m) => m.name).filter((n) => n !== null);
  const id = look.remoteScenes[Math.max(0, order.indexOf(machine)) % look.remoteScenes.length];
  return { id, ...look.scenes[id] };
}

// Text in the look's display font (Silkscreen, Orbitron, Shippori Mincho...).
export const pixel = (look, el, size, color) => el.font_family(look.fonts.pixel).text_size(size).text_color(color);

// Text in the look's name font (VT323, Share Tech Mono, Yuji Syuku...).
export const mono = (look, el, color, scale = 1) =>
  el.font_family(look.fonts.mono).text_size(Math.round((look.fonts.monoSize ?? 20) * scale)).text_color(color);

// An art file of the look: `art(look, "icon-dither")`.
export const art = (look, name) => `${look.art}/${name}.${look.ext ?? "svg"}`;
