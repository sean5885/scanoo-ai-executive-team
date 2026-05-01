import { longTaskPack } from "./long-task.mjs";
import { multiAgentCollabPack } from "./multi-agent-collab.mjs";
import { pdfCrossDocPack } from "./pdf-cross-doc.mjs";
import { pdfSingleDocPack } from "./pdf-single-doc.mjs";

export const productionLikePacks = Object.freeze([
  pdfSingleDocPack,
  pdfCrossDocPack,
  longTaskPack,
  multiAgentCollabPack,
]);

export const productionLikePackMap = Object.freeze(Object.fromEntries(
  productionLikePacks.map((pack) => [pack.id, pack]),
));

export const productionLikeCases = Object.freeze(
  productionLikePacks.flatMap((pack) => pack.cases || []),
);
