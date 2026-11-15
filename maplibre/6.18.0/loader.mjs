import * as maplibregl from './maplibre-gl.mjs';
window.__castleagueMapLibre = maplibregl;
window.dispatchEvent(new Event('castleague:maplibre'));
