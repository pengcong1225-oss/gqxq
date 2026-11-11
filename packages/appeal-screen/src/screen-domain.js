export const labels={water:'供水',gas:'供气',le24:'24小时内','24to48':'24至48小时','48to72':'48至72小时',gt72:'72小时以上',approved:'已审批','planned-water':'计划停水','planned-gas':'计划停气','emergency-water':'突发停水','emergency-gas':'突发停气','water-project':'供水施工','gas-project':'燃气施工',__missing__:'未映射'}
export const formatValue=v=>v===null||v===undefined?'不可计算':typeof v==='number'?Number(v.toFixed(2)).toLocaleString():v
