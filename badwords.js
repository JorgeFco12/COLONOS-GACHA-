'use strict';
// Lista de palabras prohibidas en nombres de usuario. Puedes añadir o quitar palabras aquí (en minúsculas, sin acentos).
// SUBSTR: se prohíbe si el nombre CONTIENE la palabra (ignora mayúsculas, acentos, números por letras y repeticiones: p.u.t.a, pu7a, puuuta).
// EXACT: palabras cortas que solo se prohíben si el nombre es esa palabra (o está formado solo por ella).
const SUBSTR = [
  // español
  'puta', 'puto', 'pendejo', 'pendeja', 'cabron', 'cabrona', 'chingada', 'chingar', 'chinga', 'verga', 'mierda', 'culo', 'culero',
  'joder', 'jodido', 'gilipollas', 'gilipolla', 'imbecil', 'idiota', 'estupido', 'estupida', 'marica', 'maricon', 'mamada',
  'zorra', 'perra', 'cojudo', 'huevon', 'pelotudo', 'boludo', 'malparido', 'gonorrea', 'hijueputa', 'hijodeputa', 'hijoputa',
  'mongolo', 'retrasado', 'subnormal', 'tarado', 'violador', 'pedofilo', 'pederasta', 'pinche', 'follar', 'coger', 'cagada',
  'hitler', 'negrata', 'sudaca', 'panocha', 'chocha', 'pajero', 'mamabicho', 'lameculos', 'comemierda',
  // inglés
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'dickhead',
  'motherfucker', 'pussy', 'wetback', 'tranny', 'rapist', 'pedophile', 'cocksucker', 'jackass', 'dumbass',
];
const EXACT = ['hdp', 'ctm', 'ptm', 'hp', 'nazi', 'fag', 'dick', 'cock', 'cum', 'kike', 'chink', 'spic', 'coon', 'tonto', 'tonta', 'sexo', 'porno', 'porn', 'anal', 'pene', 'vagina', 'tetas', 'pito'];

const MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[0134578 9]/g, c => MAP[c] || '').replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
const SUB = SUBSTR.map(norm), EX = new Set(EXACT.map(norm));
function isBad(name) {
  const n = norm(name); if (!n) return false;
  if (EX.has(n)) return true;
  return SUB.some(w => w && n.includes(w));
}
module.exports = { isBad };
