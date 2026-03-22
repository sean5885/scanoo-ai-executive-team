import { pickTechTerm } from '../utils/pick-tech-term.mjs';

const MAP = {
  routing: ['routing', 'planner', 'lane', 'agent'],
  planner: ['planner', 'routing', 'task', 'lane'],
  sop: ['sop', 'delivery', 'process'],
  okr: ['okr', 'goal', 'tracking'],
};

export function rewriteQuery(keyword, question) {
  if (keyword && MAP[keyword]) return MAP[keyword];

  const t = pickTechTerm(question);
  if (t && MAP[t]) return MAP[t];

  return keyword ? [keyword] : [];
}
