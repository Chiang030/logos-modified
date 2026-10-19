/** Synthetic provider responses, not a real model's reasoning or an engineering result. */
export const demoPrompt = "演示：查询 6061 铝合金的密度，再计算体积 0.002 m³ 的零件质量，给出单位和结果。";
export const demoResponse = (round) => [
  { reasoning_content: "演示 reasoning 摘要：先查询材料密度。", tool: "demo_material_lookup", args: { material: "aluminum_6061" } },
  { reasoning_content: "演示 reasoning 摘要：使用工具返回的密度与用户给定体积计算质量。", tool: "demo_mass_calculate",
    args: { density_kg_m3: 2700, volume_m3: 0.002 } },
  { reasoning_content: "演示 reasoning 摘要：核对质量计算结果与单位。", content: "演示结果：密度为 2700 kg/m³，体积为 0.002 m³，质量为 5.4 kg。这是遥测演示数据。" },
][round];

export function registerDemoTools(pi) {
  pi.registerTool({ name: "demo_material_lookup", label: "演示材料查询", description: "Synthetic material lookup for tracing acceptance",
    parameters: { type: "object", properties: { material: { type: "string" } }, required: ["material"] },
    async execute(_id, args) {
      return { content: [{ type: "text", text: "演示材料 aluminum_6061 的密度为 2700 kg/m³。" }],
        details: { synthetic: true, material: args.material, density_kg_m3: 2700, source: "local_fixture" } };
    } });
  pi.registerTool({ name: "demo_mass_calculate", label: "演示质量计算", description: "Multiply density by volume for tracing acceptance",
    parameters: { type: "object", properties: { density_kg_m3: { type: "number" }, volume_m3: { type: "number" } },
      required: ["density_kg_m3", "volume_m3"] },
    async execute(_id, args) {
      const mass = args.density_kg_m3 * args.volume_m3;
      return { content: [{ type: "text", text: `质量 = ${args.density_kg_m3} × ${args.volume_m3} = ${mass} kg。` }],
        details: { synthetic: true, mass_kg: mass, formula: "density_kg_m3 * volume_m3" } };
    } });
}
