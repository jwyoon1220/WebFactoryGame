// =============================================================================
//  labels — Korean display names/icons for the raw enum ids used internally.
//
//  Kept as one lookup table so the UI never shows raw enum names (e.g.
//  "IronOre", "Smelter") to the player; sim/shared code still uses the compact
//  numeric ids everywhere else.
// =============================================================================

import { EntityType, ItemId } from "@shared/types";
import { RECIPES } from "@shared/recipes";

export const ITEM_LABEL: Partial<Record<ItemId, string>> = {
  [ItemId.IronOre]: "철광석",
  [ItemId.CopperOre]: "구리광석",
  [ItemId.Coal]: "석탄",
  [ItemId.Stone]: "돌",
  [ItemId.IronPlate]: "철판",
  [ItemId.CopperPlate]: "구리판",
  [ItemId.IronGear]: "톱니바퀴",
  [ItemId.CopperCable]: "구리선",
  [ItemId.Circuit]: "회로기판",
  [ItemId.SciencePackRed]: "적색 과학팩",
  [ItemId.SciencePackGreen]: "녹색 과학팩",
};
export function itemLabel(id: ItemId): string {
  return ITEM_LABEL[id] ?? `아이템 #${id}`;
}

export const ITEM_ICON: Partial<Record<ItemId, string>> = {
  [ItemId.IronOre]: "🪨",
  [ItemId.CopperOre]: "🟤",
  [ItemId.Coal]: "⚫",
  [ItemId.Stone]: "🌑",
  [ItemId.IronPlate]: "▪️",
  [ItemId.CopperPlate]: "🟧",
  [ItemId.IronGear]: "⚙️",
  [ItemId.CopperCable]: "🧵",
  [ItemId.Circuit]: "🔌",
  [ItemId.SciencePackRed]: "🔴",
  [ItemId.SciencePackGreen]: "🟢",
};
export function itemIcon(id: ItemId): string {
  return ITEM_ICON[id] ?? "◽";
}

export const ENTITY_LABEL: Partial<Record<EntityType, string>> = {
  [EntityType.Belt]: "컨베이어 벨트",
  [EntityType.Splitter]: "분배기",
  [EntityType.Merger]: "병합기",
  [EntityType.Miner]: "채굴기",
  [EntityType.Inserter]: "인서터",
  [EntityType.LongInserter]: "롱암 인서터",
  [EntityType.FilterInserter]: "필터 인서터",
  [EntityType.Smelter]: "제련소",
  [EntityType.Assembler]: "조립기",
  [EntityType.Lab]: "연구소",
  [EntityType.Chest]: "상자",
  [EntityType.PowerPole]: "전신주",
  [EntityType.Generator]: "발전기",
};
export function entityLabel(t: EntityType): string {
  return ENTITY_LABEL[t] ?? `건물 #${t}`;
}

export const ENTITY_ICON: Partial<Record<EntityType, string>> = {
  [EntityType.Belt]: "➡️",
  [EntityType.Miner]: "⛏️",
  [EntityType.Smelter]: "🔥",
  [EntityType.Assembler]: "⚙️",
  [EntityType.Lab]: "🔬",
  [EntityType.Chest]: "📦",
  [EntityType.Generator]: "🔋",
  [EntityType.PowerPole]: "🗼",
};
export function entityIcon(t: EntityType): string {
  return ENTITY_ICON[t] ?? "❓";
}

/** One line describing what a building does, used in tooltips and the guide. */
export const ENTITY_DESC: Partial<Record<EntityType, string>> = {
  [EntityType.Miner]: "광석 타일 위에 설치하면 자동으로 광석을 캐냅니다.",
  [EntityType.Belt]: "아이템을 놓인 방향으로 실어 나릅니다. 드래그하면 길게 깔립니다.",
  [EntityType.Smelter]: "광석을 판(plate)으로 제련합니다.",
  [EntityType.Assembler]: "판·부품을 조합해 톱니바퀴·회로·과학팩 등을 만듭니다.",
  [EntityType.Lab]: "과학팩을 소모해 기술을 연구합니다.",
  [EntityType.Chest]: "아이템을 보관하는 저장 상자입니다.",
  [EntityType.Generator]: "석탄을 태워 전력망에 전기를 공급합니다.",
  [EntityType.PowerPole]: "주변 기계에 전력을 공급하는 전신주입니다.",
};
export function entityDesc(t: EntityType): string {
  return ENTITY_DESC[t] ?? "";
}

const RECIPE_LABEL: Record<number, string> = {
  1: "철판 제련",
  2: "구리판 제련",
  3: "톱니바퀴 조립",
  4: "구리선 조립",
  5: "회로기판 조립",
  6: "적색 과학팩 생산",
  7: "녹색 과학팩 생산",
};
export function recipeLabel(index: number): string {
  return RECIPE_LABEL[index] ?? RECIPES[index]?.name ?? `레시피 #${index}`;
}

/** Recipes a given machine type can be switched between (miner excluded — it
 *  always mines whatever ore is beneath it). */
export function recipesForMachine(type: EntityType): Array<{ index: number; label: string }> {
  return RECIPES.map((r, index) => ({ r, index }))
    .filter(({ r }) => r.machine === type && r.inputs.length > 0)
    .map(({ index }) => ({ index, label: recipeLabel(index) }));
}
