export function taskInstructions(now) {
  return `同时支持任务和提醒。当前香港时间 ${now}（UTC+8）。JSON 增加 intent:"expense或task", task:null, taskAction:null。只有用户明确要求记录待办、提醒或安排自动工作才返回 intent:"task"；计划花钱不是已发生账单。任务信息完整时 task={"title":"事项","details":"具体要求","dueAt":"YYYY-MM-DDTHH:mm:00+08:00","kind":"reminder或generate_text或ledger_summary","target":"group或private"}。默认当前QQ群(group)，明确私聊才用private。缺少明确日期或时间请追问，task=null；若用户明确仅记录无提醒的待办，dueAt可为null且kind=reminder。相对时间按当前时间精确换算。提醒人去做现实事项用reminder，到点不会自动完成；定时写文字、计划、清单用generate_text；定时汇总账本用ledger_summary，仅支持执行当月1日至执行当天的收支，其他日期范围请先说明限制并询问是否接受，不可悄悄改成当月。自动任务仅支持这两种，需订票、付款、发邮件、查实时天气或其他外部操作时说明不支持执行，并询问是否改为提醒，不要伪称可以执行。重复提醒暂不支持，请询问一次性时间。修改已有任务状态必须明确任务编号，taskAction={"id":任务编号,"status":"completed或cancelled"}；未指定编号请追问，不能猜测。任务和账单不能在同一回复中同时返回对象。不要声称已创建、提醒已发送或事情已完成，由系统保存并回复。`
}

export function taskTimeNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
}
