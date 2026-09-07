import { SHARED_ENGLISH_EXACT, englishErrorFallback, normalizeUiLanguage } from '../../shared/uiLanguage.js';

const UBUDDY_ENGLISH_EXACT = Object.freeze({
  '所有人': 'Everyone',
  '群内 uBuddy': 'Group uBuddies',
  '提及群成员': 'Mention group member',
  '明确通知': 'Explicitly notify',
  '位自然人成员，不包含 uBuddy': 'human members, excluding uBuddy',
  '位成员的 uBuddy': "members' uBuddies",
  '消息已读情况': 'Message read status',
  '已读': 'Read',
  '未读': 'Unread',
  '暂无已读成员': 'No one has read this yet',
  '全部成员已读': 'Read by everyone',
  '从我的群组删除': 'Remove from My Groups',
  '已从“我的群组”删除。': 'Removed from My Groups.',
  '任务已收到，正在进入接单处理队列': 'Task received and entering the intake queue',
  '任务已收到': 'Task Received',
  '正在整理任务要求': 'Organizing task requirements',
  '正在准备隔离工作区': 'Preparing the isolated workspace',
  '接收方 uBuddy 已确认收到委托，无需重复派发。': 'The recipient’s uBuddy has confirmed receipt. There is no need to dispatch the task again.',
  'uBuddy 正在整理任务要求、附件和公开上下文': 'uBuddy is organizing the requirements, attachments, and shared context',
  '整理任务要求': 'Organizing Task Requirements',
  '正在确认目标、交付物、附件和可使用的公开上下文。': 'Confirming the objective, deliverables, attachments, and permitted shared context.',
  '任务要求已整理，正在准备隔离工作区': 'Requirements organized; preparing the isolated workspace',
  '任务要求已整理，等待后台启动执行': 'Requirements organized; waiting for background execution to start',
  '任务要求已整理': 'Task Requirements Organized',
  '目标、交付要求和公开上下文已整理完成。': 'The objective, delivery requirements, and shared context have been organized.',
  'uBuddy 正在准备隔离工作区和任务会话': 'uBuddy is preparing the isolated workspace and task session',
  '准备隔离工作区': 'Preparing Isolated Workspace',
  '正在建立隔离工作区、同步公开任务资料并检查执行环境。': 'Creating the isolated workspace, syncing shared task materials, and checking the execution environment.',
  'uBuddy 正在选择合适的 Agent 并生成执行步骤': 'uBuddy is selecting an Agent and generating execution steps',
  '规划 Agent 和执行步骤': 'Planning Agents and Execution Steps',
  '正在匹配可用 Agent、拆分任务节点并确认交付方式。': 'Matching available Agents, splitting task nodes, and confirming the delivery method.',
  '任务看板已建立，正在安排 Agent 执行': 'The task board is ready; scheduling Agent execution',
  '任务看板已建立': 'Task Board Ready',
  '执行节点已经创建，后续进度将在当前看板中持续更新。': 'Execution nodes have been created. Further progress will continue updating on this board.',
  '当前有多个任务正在运行或等待。请选择要继续的任务，或明确选择“创建新任务”后再发送。': 'Multiple tasks are currently running or waiting. Select the task you want to continue, or explicitly choose “Create New Task” before sending.',
  '好的，我先把这部分作为当前委托的上下文保存，不会发布。你可以继续补充；准备好后告诉我参与人并明确说“确认发布”。': 'Got it. I saved this as context for the current request without publishing it. You can keep adding details; when ready, name the participants and explicitly say “Confirm Dispatch.”',
  '已取消本次多人分工，没有创建任务、委托或协作组。': 'This multi-person assignment has been cancelled. No task, delegation, or collaboration group was created.',
  'uBuddy 再次未能生成可验证的多人分工方案。参与人和任务要求仍已保留，当前没有派发任何任务。': 'uBuddy still could not generate a valid multi-person assignment plan. The participants and requirements have been preserved, and no task was dispatched.',
  '已取消这份分工方案，没有创建任务、委托或协作组。': 'This assignment plan has been cancelled. No task, delegation, or collaboration group was created.',
  '请直接说明要修改的参与人、职责或依赖关系；如涉及人员变化，请重新使用 @ 选择。修改后 uBuddy 会生成新版本并再次请你确认。': 'Describe the participants, responsibilities, or dependencies you want to change. Use @ again if the participants change. uBuddy will generate a new version for your confirmation.',
  'uBuddy 无法安全恢复上一轮多人协作上下文，因此没有创建任务、协作组或委托。请重新发送原始任务并重新使用 @ 选择参与人。': 'uBuddy could not safely restore the previous collaboration context, so no task, collaboration group, or delegation was created. Send the original task again and use @ to select the participants.',
  '已取消这次多人协作澄清，没有创建任务、协作组或委托。': 'This collaboration clarification has been cancelled. No task, collaboration group, or delegation was created.',
  '已更新当前任务的背景和要求，但没有创建任务、委托或任务群。你可以继续补充；准备好后请明确说“创建任务”或“确认派发”。': 'The current task context and requirements have been updated, but no task, delegation, or task group was created. You can keep adding details; when ready, explicitly say “Create Task” or “Confirm Dispatch.”',
  '我已经识别到接收人，但还缺少明确的任务要求。请补充需要完成的内容、期望交付物或相关附件。': 'I identified the recipients, but the task requirements are still unclear. Add what needs to be done, the expected deliverables, or relevant attachments.',
  'uBuddy 无法可靠判断这是“负责人向他人派发”还是“发起人也参与的同事协作”，因此没有创建任务。请明确说明发起人是否也要承担一部分工作。': 'uBuddy could not reliably determine whether this is an owner delegating work or a peer collaboration that includes the requester, so no task was created. Clarify whether the requester should also perform part of the work.',
  'uBuddy 暂时未能生成可验证的多人分工方案。参与人选择和任务要求已保留，当前没有派发任何任务。': 'uBuddy could not generate a valid multi-person assignment plan. The participant selection and task requirements have been preserved, and no task was dispatched.',
  '这个任务既可以由我直接完成，也可以使用多 Agent 协作。请选择本次执行方式。': 'I can handle this task directly or use multi-Agent collaboration. Choose an execution mode for this task.',
  '这项多人任务包含高风险操作，尚未派发。请确认任务范围、账号权限和不可逆操作后，再选择“确认派发”。': 'This multi-person task includes high-risk operations and has not been dispatched. Confirm the scope, account permissions, and irreversible actions before choosing “Confirm Dispatch.”',
  '部分候选人没有可用的公开简介，或 uBuddy 对自动选人的把握不足。为避免任务被卡住，已回退为所有明确 @ 用户参与；确认后才会派发。': 'Some candidates do not have an available public profile, or uBuddy lacks enough confidence to select participants automatically. To avoid blocking the task, all explicitly mentioned users have been selected; dispatch still requires confirmation.',
  '自动 Profile 筛选未启用，沿用所有明确 @ 用户参与的兼容行为。': 'Automatic profile-based selection is disabled, so all explicitly mentioned users will continue to participate.',
  '组织成员名单在确认前发生了变化，旧确认已失效。以下是按最新成员生成的新方案：': 'The organization membership changed before confirmation, so the previous confirmation is no longer valid. Here is a new plan based on the latest membership:',
  '每次只能选择一个组织的所有成员。': 'Select everyone from only one organization at a time.',
  '组织成员范围无效，请重新从 @ 菜单选择。': 'The organization audience is invalid. Select it again from the @ menu.',
  '“@组织所有人”只能用于当前打开的组织 Workspace。': '“@Everyone in Organization” is available only in the currently open organization Workspace.',
  '当前账号已不属于该组织，不能向组织成员派发任务。': 'This account is no longer a member of the organization and cannot dispatch tasks to its members.',
  '当前组织没有其他可派发任务的成员。': 'The current organization has no other eligible task recipients.',
  '我识别到你想发布委托，但当前没有可委托的好友。请先添加好友，再使用 @ 菜单创建任务群。': 'I detected a delegation request, but no eligible contacts are available. Add a contact first, then use the @ menu to create a task group.',
  '当前 uBuddy 会话里没有可查询的任务产物。': 'There are no task artifacts to show in this uBuddy conversation.',
  '当前 uBuddy 会话里没有可查询的任务结果。': 'There are no task results to show in this uBuddy conversation.',
  '当前 uBuddy 会话里没有正在执行或最近完成的任务。': 'There are no running or recently completed tasks in this uBuddy conversation.',
  '产物位置：': 'Artifact locations:',
  '任务仍在执行，后续节点可能继续生成或更新产物。': 'The task is still running. Later nodes may create or update additional artifacts.',
  '如需查看某一个任务的详细进度，请回复任务名称。': 'Reply with a task name to view detailed progress for that task.',
  '正在等待可执行节点进入队列。': 'Waiting for an executable node to enter the queue.',
  '当前还没有可采用的已保存交付版本。': 'There is no saved delivery version available to accept yet.',
  '我还不能确定你是要采用当前版本，还是继续修改。请明确说“采用最新版”或直接提出修改要求。': 'I cannot determine whether you want to accept the current version or continue revising it. Say “Accept Latest Version” or describe the requested changes.',
  '当前没有正在执行的 uBuddy 任务。': 'There is no running uBuddy task.',
  '询问模式不会根据任务数量猜测取消目标。请先从任务选择器选择要停止的任务，再重新发送“取消任务”。': 'Inquiry mode will not guess which task to cancel based on the number of active tasks. Select the task you want to stop from the task picker, then send “Cancel Task” again.',
  '询问模式只能取消通过任务选择器明确指定的任务。请从对应任务进度记录停止当前工作。': 'Inquiry mode can cancel only a task explicitly selected from the task picker. Stop this work from its task progress entry.',
  '当前为询问模式，切换到任务模式后可操作': 'Inquiry mode is active. Switch to Task mode to use these actions.',
  '当前为讨论模式，切换到任务模式后可操作': 'Discussion mode is active. Switch to Task mode to use these actions.',
  '当前有多个任务正在执行，请从对应进度记录停止：': 'Multiple tasks are running. Stop the intended task from its progress entry:',
  '任务图已完成并保存，正在等待符合要求的员工空闲。': 'The task graph is complete and saved. Waiting for an eligible Agent to become available.',
  'uBuddy 正在创建任务并安排执行': 'uBuddy is creating the task and scheduling execution',
  '执行已中断': 'Execution Interrupted',
  '处理已停止。': 'Processing stopped.',
  '已中止回答。': 'Response stopped.',
  '交付物已通过验收。': 'The deliverable passed review.',
  '待我处理': 'Needs My Attention',
  '等待对方': 'Waiting for Others',
  '进行中': 'In Progress',
  '已结束': 'Closed',
  '集中查看进展和待办': 'Track progress and pending work in one place',
  '打开任务面板': 'Open Task Panel',
  '关闭任务面板': 'Close Task Panel',
  '任务状态概览': 'Task Status Overview',
  '任务筛选': 'Task Filters',
  '待你验收': 'Awaiting Your Review',
  '等待对方验收': 'Waiting for the Other Party to Review',
  '查看并验收': 'Review Delivery',
  '查看并处理': 'Review and Resolve',
  '查看交付': 'View Delivery',
  '查看交付：': 'View Delivery: ',
  '任务详情：': 'Task Details: ',
  '交付结果与验收记录': 'Delivery Results and Review',
  '任务进度与执行记录': 'Task Progress and Execution',
  '当前交付状态': 'Delivery Status',
  '已交付 · 等待发出方验收': 'Delivered · Awaiting Requester Review',
  '结果已经发送给任务发出方；对方可以确认任务结束，或打回重做。': 'The result has been sent to the requester, who can accept it or request revisions.',
  '快速验收': 'Quick Accept',
  '查看交付详情': 'View Delivery',
  '打开任务': 'Open Task',
  '停止整个任务': 'Stop Entire Task',
  '交付需要修正': 'Delivery Needs Revision',
  '交付结果已就绪': 'Delivery Is Ready',
  '请在任务工作区查看完整结果': 'View the complete result in the task workspace',
  '交付结果已保存': 'Delivery result saved',
  '查看任务': 'View Task',
  '需要修正': 'Needs revision',
  '轻量消息已发送；没有创建任务、工作区或任务群。': 'The message was sent without creating a task, workspace, or task group.',
  '一对一委托已发布；不会创建任务群，接收方将在私有委托工作区处理。': 'The direct delegation was published. No task group will be created; the recipient will handle it in a private delegation workspace.',
  '由 uBuddy 直接完成，流程更快，不创建多 Agent 任务图。': 'Handled directly by uBuddy for a faster workflow without creating a multi-Agent task graph.',
  '由 uBuddy 拆分任务、选择专业 Agent、跟踪进度、审核并统一交付。': 'uBuddy splits the task, selects specialized Agents, tracks progress, reviews the work, and delivers a consolidated result.',
  '请确认这项任务最终需要交付哪一种产物。': 'Confirm which final deliverable this task should produce.',
  '以最后阶段产物为最终交付': 'Use the final-stage output as the final deliverable',
  '将提到的产物都作为正式交付': 'Treat every mentioned output as a formal deliverable',
  '多人分工方案': 'Multi-Person Assignment Plan',
  '参与人选择': 'Participant Selection',
  '已选择': 'Selected',
  '未选择': 'Not Selected',
  '必须参与': 'Required',
  '当前未进入最终派发': 'Not included in the final dispatch',
  '明确单人': 'Explicit Single Participant',
  '用户要求全员': 'All Participants Required',
  '当前组织成员已作为完整参与人范围，确认后才会派发。': 'All current organization members are included. Dispatch will begin only after confirmation.',
  '当前组织的所有其他成员都进入分工方案；方案必须由发起人确认后才会派发。': 'All other members of the current organization are included in the assignment plan. The requester must confirm before dispatch.',
  '组织成员名单已变化，uBuddy 已刷新参与人并要求重新确认。': 'The organization membership changed. uBuddy refreshed the participants and requires confirmation again.',
  '多人候选': 'Candidate Pool',
  '同事协作 · 发起人参与': 'Peer Collaboration · Requester Participates',
  '负责人派发 · 发起人协调': 'Owner Dispatch · Requester Coordinates',
  '等待确认': 'Awaiting Confirmation',
  '已确认': 'Confirmed',
  '已替换': 'Superseded',
  '最终整合：发起人的 uBuddy': 'Final Consolidation: Requester’s uBuddy',
  '确认派发': 'Confirm Dispatch',
  '修改方案': 'Revise Plan',
  '全员参与': 'Include Everyone',
  '取消方案': 'Cancel Plan',
  '需要确认': 'Confirmation Required',
  '选择执行方': 'Choose Who Completes It',
  '尚未创建任务': 'No Task Has Been Created',
  '这项任务尚未指定 Agent 或联系人，请选择完成方式。': 'No Agent or contact was selected for this task. Choose how it should be completed.',
  '本地完成': 'Complete Locally',
  '@ 联系人完成': 'Complete with a Contact',
  '由 uBuddy 选择合适的本地 Agent 执行。': 'uBuddy will select an appropriate local Agent.',
  '打开联系人列表，明确选择任务接收人。': 'Open the contact list and choose a recipient.',
  '不会仅凭聊天记录自动选择联系人。': 'A contact is never selected from conversation history alone.',
  '选择联系人': 'Choose a Contact',
  '搜索联系人': 'Search Contacts',
  '暂无匹配的联系人': 'No Matching Contacts',
  '由该联系人完成刚才讨论的任务。': 'Have this contact complete the task discussed above.',
  '任务上下文过长，uBuddy 已停止派发。请压缩当前会话上下文后重试。': 'The task context was too large, so uBuddy stopped before dispatch. Compress this conversation context and try again.',
  '已通过后续消息回答': 'Answered in a later message',
  '其他答案': 'Another Answer',
  '输入更符合你实际情况的回答': 'Enter an answer that better matches your situation',
  '请输入你的答案': 'Enter your answer',
  '需要你确认': 'Your Confirmation Is Required',
  '选择一项，或输入自己的答案': 'Choose an option or enter your own answer',
  '提交后 uBuddy 会根据你的回答继续处理。': 'uBuddy will continue after you submit your answer.',
  '选择执行方式': 'Choose an Execution Mode',
  '仅本次任务生效': 'Applies to This Task Only',
  '由 uBuddy 直接完成': 'Handle Directly with uBuddy',
  '使用多 Agent 协作': 'Use Multi-Agent Collaboration',
  '流程更快，不创建多 Agent 任务图。': 'Faster workflow without creating a multi-Agent task graph.',
  '拆分任务、跟踪进度、审核并统一交付。': 'Split the task, track progress, review the work, and deliver a consolidated result.',
  '两种执行方式都可行，请选择更符合本次需求的一种。': 'Both execution modes are viable. Choose the one that best fits this task.',
  '生成超时': 'Generation Timed Out',
  '模型服务暂时不可用': 'Model Service Temporarily Unavailable',
  '方案格式未通过检查': 'Plan Format Validation Failed',
  '方案完整性未通过检查': 'Plan Completeness Validation Failed',
  '方案生成未完成': 'Plan Generation Did Not Complete',
  '尚未生成': 'Not Generated',
  '已恢复': 'Recovered',
  '重新生成方案': 'Regenerate Plan',
  '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 因此无法执行任务。请接收方先安装 Skill，并确认 PPT Agent 已招募启用后重新调度；任务上下文已保留。': 'The recipient device does not have the PPT Creation Skill installed, so the PPT Agent cannot execute this task. Ask the recipient to install the Skill, confirm that the PPT Agent is hired and active, and then dispatch the task again. The task context has been preserved.',
  '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 因此无法执行任务。': 'The recipient device does not have the PPT Creation Skill installed, so the PPT Agent cannot execute this task.',
  '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 无法执行任务。': 'The recipient device does not have the PPT Creation Skill installed, so the PPT Agent cannot execute this task.',
  '接收方当前没有已招募并启用的 PPT Agent。请接收方完成招募或重新启用后再调度；任务上下文已保留。': 'The recipient does not currently have a hired and active PPT Agent. Ask the recipient to hire or reactivate the PPT Agent, then dispatch the task again. The task context has been preserved.',
});

const ENGLISH_EXACT = Object.freeze({
  '添加表情': 'Add reaction',
  '添加表情回应': 'Add reaction',
  '表情回应': 'Reactions',
  '选择一个表情': 'Choose a reaction',
  '表情回应失败。': 'Reaction failed.',
  '回应': 'React',
  '笑脸与人物': 'Smileys & People',
  '手势与人物': 'Gestures & People',
  '动物与自然': 'Animals & Nature',
  '食物与活动': 'Food & Activities',
  '符号与物品': 'Symbols & Objects',
  '常用表情': 'Frequently used',
  '默认表情': 'All emoji',
  'Agent 当前工作': 'Agent Current Task',
  '正在处理任务': 'Working on the task',
  '当前受阻': 'Currently Blocked',
  '任务节点': 'Task Node',
  '任务状态已更新': 'Task status updated',
  '打开任务工作区': 'Open Task Workspace',
  '状态更新中': 'Updating Status',
  '刚刚更新': 'Updated just now',
  '失败': 'Failed',
  '有限上下文': 'Limited Context',
  '来源已撤回、租约已过期或当前无权访问。': 'The source was withdrawn, its lease expired, or you no longer have access.',
  '，已设为默认工作空间': ', set as the default workspace',
  '凭证测试通过。': 'Credential test passed.',
  '实际大小': 'Actual Size',
  'uBuddy 执行方式选择': 'uBuddy Execution Mode',
  '完成当前工作后同步到团队': 'Sync to the team after finishing the current work',
  '验证中': 'Verifying',
  '交付中': 'Delivering',
  '等待恢复': 'Waiting to Resume',
  '已跳过': 'Skipped',
  '@所有人': '@Everyone',
  '所有人': 'Everyone',
  '个人空间可用': 'Available in Personal Workspace',
  '本机运行依赖尚未就绪。': 'Local runtime dependencies are not ready.',
  '请稍候…': 'Please wait…',
  '运行环境未就绪': 'Runtime Not Ready',
  '内置 Python': 'Bundled Python',
  '未检测到': 'Not Detected',
  '系统 Python': 'System Python',
  '修复运行环境': 'Repair Runtime',
  '在线调查': 'Online Research',
  '离线调查': 'Offline Research',
  '已连接': 'Connected',
  '未启用': 'Not Enabled',
  '机器人长连接已启用': 'Bot persistent connection enabled',
  '机器人长连接未启用': 'Bot persistent connection not enabled',
  '测试凭证': 'Test Credentials',
  '绑定码未显示': 'Pairing code not shown',
  '管理当前设备上的飞书机器人连接。': 'Manage the Feishu bot connection on this device.',
  '近期工作汇报': 'Recent Work Report',
  '等待范围同步': 'Waiting for scope synchronization',
  '暂未找到结构化工作记录': 'No structured work records found yet',
  '你可以补充未记录的工作；若不补充，等待期结束后只会返回“未找到结构化记录”，不会代表你确认没有开展其他工作。': 'You can add work that was not recorded. If you do not add anything, the response after the waiting period will only state that no structured records were found; it will not mean that you confirmed no other work occurred.',
  '补充已完成、进行中、阻塞或下一步': 'Add completed work, work in progress, blockers, or next steps',
  '生成私人草稿': 'Generate Private Draft',
  ...SHARED_ENGLISH_EXACT,
  ...UBUDDY_ENGLISH_EXACT,
  '返回': 'Back',
  '返回应用': 'Back to App',
  '关闭': 'Close',
  '关闭当前会话': 'Close Current Conversation',
  '安装更新需要关闭并重启 Janus。是否现在安装？': 'Installing the update will close and restart Janus. Install now?',
  '发现 Janus 更新': 'A Janus update is available',
  '打开更新中心': 'Open Update Center',
  '账户菜单': 'Account Menu',
  '账户与工作空间': 'Account and Workspaces',
  '个人空间': 'Personal Workspace',
  '工作群已归档。': 'Work group archived.',
  '当前账号已经加入该组织。': 'This account has already joined the organization.',
  'Janus 已是最新版本。': 'Janus is up to date.',
  '更新下载失败': 'Update download failed',
  '更新已下载并通过校验，可在准备好后安装。': 'The update has been downloaded and verified. Install it when you are ready.',
  '确认卸载此技能？': 'Uninstall this Skill?',
  '该文件可能包含可执行内容，打开后可能修改系统。确认继续吗？': 'This file may contain executable content that could modify your system. Open it anyway?',
  '解散群聊后将表示任务结束，且该群聊不能继续发送消息。确定解散吗？': 'Dissolving this group chat will end the task, and no further messages can be sent. Dissolve it?',
  '解散后将不能继续发送消息，确定解散吗？': 'You will not be able to send more messages after dissolving this group chat. Dissolve it?',
  '确定退出该群聊吗？': 'Leave this group chat?',
  '撤回后，对方将看不到这条内容，对方 uBuddy 也会从任务整理中移除它。确认撤回吗？': 'The recipient will no longer see this content, and their uBuddy will remove it from the task context. Withdraw it?',
  '移除后，该成员将无法查看新消息，其未完成任务会被撤回。确定继续吗？': 'This member will no longer see new messages, and their unfinished tasks will be withdrawn. Continue?',
  '确定删除这个好友吗？': 'Remove this contact?',
  '确定拉黑这个用户吗？拉黑后会取消相关好友关系和待处理申请。': 'Block this user? Blocking will remove the contact relationship and cancel pending requests.',
  '确定停用该云端账号吗？停用后对方将无法登录或继续使用云端服务。': 'Suspend this cloud account? The user will no longer be able to sign in or use cloud services.',
  '确认该简介的新增能力范围与隐私提示，并允许按所选范围公开吗？': 'Confirm the new capability scope and privacy notice for this profile, and share it with the selected audience?',
  '所有任务结果均已处理。解散后群聊与工作区将变为只读，确定继续吗？': 'All task results have been handled. The group chat and workspace will become read-only after dissolution. Continue?',
  '启用后，组织内所有当前成员都可调查启用时间之后的新组织消息。\n\n范围包括组织内私聊、内部群、任务群和组织 Workspace Agent 对话；不包含历史消息、个人空间、私人助理、外部群或跨组织消息。\n\n组织成员不能单独退出索引。离开组织后访问会立即撤销，离线设备最迟在 24 小时租约到期后锁定。\n\n是否确认代表组织启用？': 'After this is enabled, all current organization members can investigate new organization messages created from that point forward.\n\nThe scope includes direct messages within the organization, internal groups, task groups, and organization Workspace Agent conversations. It excludes message history, personal workspaces, private-assistant conversations, external groups, and cross-organization messages.\n\nIndividual members cannot opt out of indexing. Access is revoked immediately when a member leaves the organization, and offline devices are locked when their lease expires, within 24 hours.\n\nEnable this on behalf of the organization?',
  '委托给好友的秘书 Agent：任务标题': 'Delegate to the contact’s assistant Agent: task title',
  '请输入要让对方秘书 Agent 处理的任务内容': 'Enter the task you want the recipient’s assistant Agent to handle',
  '确认删除当前目标？目标模式会保留，你可以继续创建新目标。': 'Delete the current goal? Goal mode will remain available so you can create another goal.',
  '确定清理轮转日志和旧崩溃文件吗？当前 janus.log 会保留。': 'Clear rotated logs and old crash files? The current janus.log will be kept.',
  '当前 Memory 将被封存，并自动创建下一编号空槽。确认清除吗？': 'The current Memory will be archived and the next numbered empty slot will be created. Clear it?',
  '归档后仍可只读查看、恢复或引用，但不能直接继续发送消息。确认归档吗？': 'After archiving, this conversation can still be viewed, restored, or referenced, but you cannot send new messages until it is restored. Archive it?',
  '确认应用这次领导职级晋升？': 'Apply this leadership-level promotion?',
  '确认暂不晋升？': 'Keep the current leadership level for now?',
  '提交领导资格恢复申请？该申请必须由云端治理人员复核。': 'Submit a leadership eligibility restoration request? Cloud governance staff must review it.',
  '清空后，当前模型线程和对话上下文将从这里重新开始；聊天历史仍会保留在界面中，附件和文件不会删除，也不会影响其他 Agent。确认清空吗？': 'The current model thread and conversation context will restart from this point. Chat history will remain visible, attachments and files will not be deleted, and other Agents will not be affected. Clear the context?',
  '停止后，已完成内容会保留，未完成步骤不会继续。确认停止这个任务吗？': 'Completed work will be kept, but unfinished steps will not continue. Stop this task?',
  '取消后，已完成内容会保留，未完成步骤不会继续。确认取消这个任务吗？': 'Completed work will be kept, but unfinished steps will not continue. Cancel this task?',
  '将当前聊天上下文保存到正在使用的 memory.md，然后创建下一空白 Memory。聊天历史仍会保留，确认继续吗？': 'Save the current chat context to the active memory.md, then create the next blank Memory. Chat history will remain available. Continue?',
  '修改群聊名称': 'Rename Group Chat',
  '编辑组织名': 'Edit organization name',
  '保存组织名称': 'Save organization name',
  '取消编辑': 'Cancel editing',
  '组织名称已更新。': 'Organization name updated.',
  '组织名称保存失败。': 'Failed to save organization name.',
  '组织名称需要 2–60 个字符。': 'Organization name must be 2–60 characters.',
  '归档群聊': 'Archive group chat',
  '请输入群组备注（留空可清除）：': 'Enter a group note (leave blank to clear it):',
  '请填写需要修改的方向': 'Describe the requested changes',
  '请填写需要修改的内容': 'Describe what needs to change',
  '取消': 'Cancel',
  '确认': 'Confirm',
  '保存': 'Save',
  '删除': 'Delete',
  '编辑': 'Edit',
  '重命名': 'Rename',
  '搜索': 'Search',
  '添加': 'Add',
  '添加联系人与组织': 'Add Contacts & Organizations',
  '组织范围': 'Organization Scope',
  '组织所有人': 'Everyone in Organization',
  '不含我': 'excluding me',
  '联系人搜索与通讯录筛选彼此独立': 'Contact lookup and directory filters work independently.',
  '添加类型': 'Add Type',
  '添加联系人': 'Add Contact',
  '邮箱、用户名或用户 ID': 'Email, username, or user ID',
  '查找新联系人': 'Find New Contacts',
  '查找': 'Find',
  '查找 Janus 用户': 'Find Janus Users',
  '输入对方的邮箱、用户名或用户 ID，再发送联系人申请。': 'Enter an email, username, or user ID, then send a contact request.',
  '打个招呼': 'Say Hello',
  '选填，最多 200 字': 'Optional, up to 200 characters',
  '例如：你好，我是项目组的王明，想和你协作处理本周报告。': 'For example: Hi, I’m Alex from the project team. I’d like to collaborate on this week’s report.',
  '发送好友申请': 'Send Friend Request',
  '申请好友': 'Send Request',
  '创建': 'Create',
  '加入': 'Join',
  '刷新': 'Refresh',
  '重新读取': 'Reload',
  '重试': 'Retry',
  '打开': 'Open',
  '复制': 'Copy',
  '复制代码': 'Copy Code',
  '已复制': 'Copied',
  '下载': 'Download',
  '运行时长': 'Runtime',
  '发送时间': 'Sent At',
  '完成文件': 'Completed Files',
  '预览': 'Preview',
  '详情': 'Details',
  '更多': 'More',
  '继续': 'Continue',
  '完成': 'Done',
  '发送': 'Send',
  '设置': 'Settings',
  '账户': 'Account',
  '文件': 'File',
  '视图': 'View',
  '帮助': 'Help',
  '关于 Janus': 'About Janus',
  '消息': 'Messages',
  'Follower 报告已就绪': 'Follower Report Ready',
  '隐藏其他': 'Hide Others',
  '全部显示': 'Show All',
  '窗口': 'Window',
  '前置全部窗口': 'Bring All to Front',
  '切换语言': 'Switch Language',
  '消息与通讯录': 'Messages & Contacts',
  '消息会话': 'Message Conversations',
  '消息分组': 'Message Groups',
  '消息筛选': 'Message Filters',
  '返回主导航': 'Back to Main Navigation',
  '分组': 'Groups',
  '类型': 'Type',
  '标记': 'Marked',
  '@我': '@Me',
  '单聊': 'Direct Chats',
  '收起消息分组': 'Collapse Message Groups',
  '快捷入口': 'Shortcuts',
  '通讯录': 'Contacts',
  '通讯录目录': 'Contact Directory',
  '通讯录工作区': 'Contacts Workspace',
  '调整联系人与员工列表宽度': 'Resize Contacts and Agent List',
  '项目': 'Projects',
  '任务': 'Tasks',
  '技能': 'Skills',
  '人才市场': 'Talent',
  '移动端正在准备中': 'Mobile is in preparation',
  'Janus 移动端': 'Janus Mobile',
  '移动端平台': 'Mobile platforms',
  'Janus，随时在手边': 'Janus, always close at hand',
  'iOS 与 Android 版本将在准备就绪后公布。': 'The iOS and Android versions will be announced when ready.',
  '即将推出': 'Coming Soon',
  '移动端': 'Mobile',
  '人才模板常驻展示，可按需重复招募；每名员工都有独立聊天、Memory 与成长档案。': 'Talent templates stay available for repeat hiring, with separate chats, Memory, and growth records for each Agent.',
  '搜索人才': 'Search Talent',
  '精选人才': 'Featured Talent',
  '通用问答与分析': 'General Q&A & Analysis',
  '文件和代码任务处理': 'File & Code Tasks',
  '跨领域问题求解': 'Cross-Domain Problem Solving',
  '项目上下文与 AGENTS.md 遵循': 'Project Context & AGENTS.md',
  '结果验证与清晰交付': 'Verified, Clear Delivery',
  '系统通用回退执行 Agent；当没有更合适的专业 Agent 时，由 Generalist 按 Codex 默认执行工作流完成任务并验证结果。': 'General-purpose fallback Agent that follows the standard Janus workflow when no specialist is a better fit, including implementation and verification.',
  '系统通用回退执行 Agent；当没有更合适的专业 Agent 时，由 Generalist 按 Janus 默认执行工作流完成任务并验证结果。': 'General-purpose fallback Agent that follows the standard Janus workflow when no specialist is a better fit, including implementation and verification.',
  '全部': 'All',
  '私人助理': 'Private Assistant',
  '私人助理，本地': 'Private Assistant, Local',
  '本地隔离空间：不与其他 Agent 通信，不同步到 Janus 云端，也不占员工额度；当前请求仍会发送给你选择的模型服务。': 'Local isolated space: no Agent communication, no Janus cloud sync, and no Agent quota use. Requests still go to your selected model service.',
  '个人': 'Personal',
  '组织': 'Organization',
  '组': 'O',
  '联系人': 'Contact',
  '联系人详情': 'Contact Details',
  '设为星标联系人': 'Star Contact',
  '取消星标联系人': 'Unstar Contact',
  '星标': 'Star',
  '已星标': 'Starred',
  '联系人、群组与组织': 'Contacts, Groups & Orgs',
  '群聊': 'Group Chat',
  '创建群聊': 'New Group',
  '群组类型': 'Group Type',
  '联系人群聊': 'Chats',
  '工作群组': 'Workgroups',
  '暂无联系人群聊': 'No Contact Group Chats Yet',
  '双人私聊 · 结构化 @ 指令由 uBuddy 直接派发': 'Direct Chat · Structured @ requests are delegated by uBuddy',
  '工作群': 'Workgroup',
  '工作群视图': 'Workgroup view',
  '新任务': 'New Task',
  '新的联系人': 'Requests',
  '新联系人': 'New Contacts',
  '等待验证': 'Awaiting Verification',
  '暂无待处理': 'Nothing Pending',
  '收到的申请': 'Received Requests',
  '发出的申请': 'Sent Requests',
  '查看联系人申请': 'Review Contact Requests',
  '星标联系人': 'Starred',
  '组织内联系人': 'Members',
  '组织成员': 'Members',
  '好友': 'Friends',
  '外部联系人': 'External',
  '我的群组': 'Groups',
  '我的员工': 'My Agents',
  '编辑名称与备注': 'Edit Name & Notes',
  '设为星标员工': 'Star Agent',
  '取消星标员工': 'Unstar Agent',
  '记忆与进化': 'Memory & Evolution',
  '版本管理': 'Version Management',
  '停用员工': 'Deactivate Agent',
  '在职': 'Active',
  '员工详情分页': 'Agent Detail Tabs',
  '概览': 'Overview',
  '记忆': 'Memory',
  '成长': 'Growth',
  '工作状态': 'Work Status',
  '事件更新': 'Event Updates',
  '现在在做什么': 'Current Activity',
  '当前空闲': 'Currently Idle',
  '可以立即开始新对话或任务': 'Ready to start a new chat or task.',
  '正在使用的记忆': 'Active Memory',
  '暂无记忆': 'No Memory Yet',
  '已选择，下一次新线程生效': 'Selected; applies to the next new thread.',
  '正在使用的 Skill': 'Active Skill',
  '基础版': 'Base Version',
  '基础能力与该 Agent 的个人进化规则': 'Base capabilities and this Agent’s personal evolution rules.',
  '成长状态': 'Growth Status',
  '待评估': 'Pending Evaluation',
  '待同步': 'Pending Sync',
  '尚无进化记录': 'No Evolution History Yet',
  '名称与备注': 'Name & Notes',
  '名称与备注只影响这个 Agent 实例；同类型 Agent 仍共享基础与市场 Skill。': 'Name and notes affect only this Agent instance; Agents of the same type still share base and market Skills.',
  '恢复默认': 'Restore Defaults',
  'P 表示专业执行表现，L 表示领导任命资格；实际管理范围和协作 Memory 权限只来自具体工作的领导任命。': 'P measures specialist performance and L indicates leadership eligibility. Actual authority and shared Memory access come only from explicit assignments.',
  'P 衡量专业表现，L 衡量领导任命资格。': 'P measures professional performance; L measures leadership eligibility.',
  'P/L 职级都不会自动授予任务管理或 Memory 读取权限；实际权限始终来自具体工作的领导任命。': 'P/L levels do not automatically grant task-management or Memory access. Actual permissions always come from explicit leadership assignments.',
  '员工详情': 'Agent Details',
  '关闭员工详情': 'Close Agent Details',
  '成长与职级详情': 'Growth & Level Details',
  'Leadership actions': 'Leadership Actions',
  '试岗与治理操作': 'Trials & Governance',
  '交付质量': 'Delivery Quality',
  '可靠性': 'Reliability',
  '首次通过': 'First-Pass Success',
  '执行效率': 'Execution Efficiency',
  '协作安全': 'Collaboration Safety',
  '完成任务': 'Completed Tasks',
  '终态尝试': 'Terminal Attempts',
  '基线': 'Baseline',
  '贡献权重': 'Contribution Weight',
  '当前表现等级已达到有效任务样本要求。': 'The current performance level has enough valid task evidence.',
  '验收返工': 'Review & Rework',
  '依赖协调': 'Dependency Coordination',
  '团队提升': 'Team Uplift',
  '权限安全': 'Permission Safety',
  '有效领导任务': 'Valid Leadership Tasks',
  '跨部门任务': 'Cross-Department Tasks',
  '团队试岗': 'Team Trials',
  '跨团队试岗': 'Cross-Team Trials',
  '角色': 'Role',
  '节点': 'Nodes',
  '任务组': 'Task Groups',
  '独立执行者': 'Independent Contributor',
  '仅可在受控试岗中承担 task lead': 'Task lead only in controlled trials',
  '支持跨部门与 cross-team lead': 'Supports cross-department and cross-team leadership',
  '当前指标已满足，等待对应自动或治理流程。': 'Current metrics are satisfied; awaiting the applicable automated or governance process.',
  '继续积累有效领导任务。': 'Continue accumulating valid leadership tasks.',
  '已达到最高 Leadership 等级': 'Highest Leadership Level Reached',
  '后续继续依据滚动窗口保持资格。': 'Eligibility will continue to be evaluated over the rolling window.',
  '申诉与治理结果': 'Appeals & Governance Results',
  '尚无申诉记录。': 'No appeal records yet.',
  'Leadership 评估历史': 'Leadership Assessment History',
  '正在读取评估历史…': 'Loading assessment history…',
  '无法读取评估历史': 'Could Not Load Assessment History',
  '暂无 Leadership 评估历史。': 'No Leadership assessment history yet.',
  '评分未达到门槛': 'Score Below Threshold',
  '有效领导任务不足': 'Insufficient Valid Leadership Tasks',
  '需要已确认 P3': 'Confirmed P3 Required',
  '需要已确认 P5': 'Confirmed P5 Required',
  '需要已确认 P7': 'Confirmed P7 Required',
  'team lead 试岗不足': 'Insufficient Team-Lead Trials',
  '跨团队试岗不足': 'Insufficient Cross-Team Trials',
  '跨部门任务不足': 'Insufficient Cross-Department Tasks',
  '团队效率提升证据不足': 'Insufficient Team-Efficiency Evidence',
  '团队效率提升低于 5%': 'Team-Efficiency Improvement Below 5%',
  '需要治理批准': 'Governance Approval Required',
  '交付': 'Delivery',
  '拆解': 'Decomposition',
  '返工': 'Rework',
  '协调': 'Coordination',
  '提升': 'Uplift',
  'Agent 启用状态已由云端确认；专业与领导等级数据正在完成首次同步。': 'The Agent is active in the cloud; specialist and leadership levels are completing their initial sync.',
  '开始对话': 'Start Chat',
  '查看记忆': 'View Memory',
  'Agent 对话上下文': 'Agent Conversation Context',
  '每个 Memory 是一条可独立切换、归档和恢复的 Agent 对话分支。': 'Each Memory is an Agent conversation branch that can be switched, archived, and restored independently.',
  'Memory 如何工作？': 'How Does Memory Work?',
  '切换 Memory 会恢复它自己的消息、文件和压缩边界，并开启新的模型线程。归档只会暂停使用，不会删除内容。': 'Switching Memory restores its own messages, files, and compaction boundary, then starts a new model thread. Archiving pauses use without deleting content.',
  '活跃 Memory': 'Active Memory',
  '按最近使用排序；切换后下一条消息会使用对应上下文。': 'Sorted by recent use; the next message uses the selected context.',
  '还没有活跃 Memory。': 'No active Memory yet.',
  '已归档 Memory': 'Archived Memory',
  '可只读查看、恢复，或作为历史资料引用。': 'Available for read-only review, restoration, or use as a historical reference.',
  '没有已归档 Memory。': 'No archived Memory.',
  'Memory 内容预览': 'Memory Content Preview',
  '点击折叠': 'Click to Collapse',
  '只读归档': 'Read-Only Archive',
  '活跃上下文': 'Active Context',
  '上下文边界': 'Context Boundary',
  '相关文件路径': 'Related File Paths',
  '选择一个 Memory 查看内容预览。': 'Select a Memory to preview its content.',
  '这条 Memory 还没有消息。': 'This Memory has no messages yet.',
  '恢复并切换': 'Restore & Switch',
  '引用': 'Reference',
  '可切换': 'Available to Switch',
  '查看 Skill 版本': 'View Skill Versions',
  '模型': 'Models',
  '推理': 'Reasoning',
  '模型与推理强度': 'Models & Reasoning Effort',
  '默认模型服务': 'Default Model Service',
  '当前使用 Janus 默认模型服务，Token 用量受软件额度限制。': 'The Janus default model service is active and subject to Janus token limits.',
  '当前使用已通过连接测试的自定义 Provider，不受 Janus Token 限额。': 'The validated custom Provider is active and is not subject to Janus token limits.',
  'Codex 原始配置': 'Janus Advanced Configuration',
  'Janus 高级配置': 'Janus Advanced Configuration',
  '直接编辑 Janus 使用的原始 config.toml 和 auth.json；配置仅保存在当前设备。': 'Edit the raw config.toml and auth.json used by Janus. These files stay on this device.',
  '默认服务': 'Default',
  '手动配置': 'Manual Setup',
  '自定义 Provider': 'Custom Provider',
  'AI 自动审查': 'AI Review',
  '完全开放': 'Full Access',
  '如需使用自己的模型服务，请在下方填写 config.toml 和 auth.json；保存并测试通过后生效。自定义 Provider 不受 Janus Token 限额。': 'To use your own model service, enter config.toml and auth.json below. The custom Provider takes effect after the files are saved and pass the connection test, and is not subject to Janus token limits.',
  '自定义 Provider 配置': 'Custom Provider Configuration',
  '仅在使用自己的模型服务时展开；保存并通过连接测试后生效。': 'Configure your own Responses API Provider with config.toml and auth.json. Janus activates it only after the files are saved and the network, authentication, and model-routing checks pass.',
  '自定义模型服务已启用': 'Custom Provider Enabled',
  '当前自定义配置已经通过连接测试；展开后可以检查或修改。': 'This custom Provider passed the network, authentication, and model-routing checks. Expand to review or edit config.toml and auth.json; any change must be saved and tested again.',
  '正在读取高级配置': 'Loading Advanced Configuration',
  '配置文件仅在你打开高级模式后读取。': 'The configuration files are read only after you open the advanced section.',
  '当前使用自定义模型服务': 'Using Custom Provider',
  '当前 config.toml 与 auth.json 已通过连接测试。任一文件再次变化后需重新保存并测试。': 'The current config.toml and auth.json passed the connection test. Editing either file disables the custom Provider until you save and test the configuration again.',
  '保存高级配置并测试': 'Save Advanced Config & Test',
  '保存配置': 'Save Configuration',
  '正在保存整文件配置...': 'Saving config.toml and auth.json...',
  '自定义 Provider 已启用': 'Custom Provider Enabled',
  '自定义配置未启用': 'Custom Configuration Not Enabled',
  '自定义配置测试失败': 'Custom Configuration Test Failed',
  'Provider 网络和鉴权检查通过。': 'The Provider network and authentication checks passed.',
  'Provider Base URL 缺失或无效。': 'The Provider Base URL is missing or invalid.',
  'API Key 未配置，未执行 Provider 鉴权请求。': 'No API key is configured, so the Provider authentication request was not run.',
  'Provider /models 可用，但没有可用于验证 Responses API 的模型。': 'The Provider /models endpoint is available, but no model is available for validating the Responses API.',
  'Provider 网络或鉴权不可用。': 'The Provider network connection or authentication is unavailable.',
  '高级配置测试通过，已启用自定义模型服务。': 'The advanced configuration passed all checks. The custom Provider is now enabled.',
  '今日模型用量': 'Today’s Model Usage',
  '当前使用自定义模型服务，仅记录使用量，不设 Janus 每日额度。': 'A custom model service is active. Usage is recorded, but no Janus daily limit applies.',
  '默认模型服务今日额度': 'Default Model Service Daily Allowance',
  '北京时间每日 00:00 恢复；输入与输出 Token 按每轮实际 usage 累加。': 'Resets daily at 00:00 Beijing time. Input and output tokens are counted from each turn’s actual usage.',
  '今日图片生成用量': 'Today’s Image Generation Usage',
  '当前使用自定义图片服务，仅按当前 Provider 记录用量，不设 Janus 每日额度。': 'A custom image service is active. Usage is tracked for the current Provider only, with no Janus daily limit.',
  '今日图片生成额度': 'Daily Image Allowance',
  '生成、编辑、私人助理与 PPT 配图共享；北京时间每日 00:00 恢复。': 'Shared by generation, editing, Private Assistant, and presentation images. Resets daily at 00:00 Beijing time.',
  '自定义模型服务仅记录使用量，不设每日额度': 'Custom model services record usage without a daily limit',
  '自定义模型服务仅记录 Token 使用量，不设每日额度': 'Custom model services record token usage without a daily limit',
  '自定义服务 · 不限额': 'Custom Service · No Limit',
  '今日累计': 'Today’s Total',
  '所有 Agent、会话、模型与自动重试共同累计': 'Combined across all Agents, conversations, models, and automatic retries',
  '最近一轮': 'Latest Turn',
  '计算方式': 'How It Is Calculated',
  '每个 Codex turn 只结算一次，优先使用模型返回的 last usage；cached tokens 属于输入、reasoning tokens 属于输出，不会重复相加。线程累计 total 仅用于缺失时的增量校验。': 'Each Janus model turn is counted once, using the model’s last usage when available. Cached tokens count as input and reasoning tokens as output, without double-counting. The thread total is used only for incremental validation when data is missing.',
  '本周 Token 额度': 'Weekly Token Allowance',
  'GPT-5.x 文本': 'GPT-5.x Text',
  '输入与输出 Token 合计': 'Combined Input and Output Tokens',
  '模型返回': 'Reported by Model',
  '本轮估算': 'Estimated This Turn',
  'GPT Image-2': 'GPT Image-2',
  '文本与通用 Agent 使用相同的单轮口径：优先读取模型返回的本轮 usage，不会重复累加线程累计 total；只有累计值或没有 usage 时，才按本轮输入与回答估算。': 'Text uses the same per-turn accounting as general Agents: the current turn’s model-reported usage is preferred and the thread total is never counted twice. Estimation from the current input and response is used only when per-turn usage is unavailable.',
  '今日默认模型服务额度已用完，北京时间 00:00 后可继续使用': 'Today’s default model service allowance is exhausted. You can continue after 00:00 Beijing time.',
  '今日额度已用完': 'Today’s Allowance Is Exhausted',
  '本周 Token 额度已用完，重置后可继续对话': 'The weekly token allowance is exhausted. You can continue after it resets.',
  '搜索聊天': 'Search Chats',
  '搜索聊天...': 'Search Chats...',
  '搜索聊天（Ctrl/⌘ + F）': 'Search Chats (Ctrl/⌘ + F)',
  '搜索通讯录': 'Search Contacts',
  '搜索设置...': 'Search settings...',
  '相关设置': 'Related settings',
  '未找到相关设置': 'No related settings found',
  '能力简介预览': 'Capability Profile Preview',
  '调查政策': 'Research Policy',
  '设置导航': 'Settings Navigation',
  '输出文件': 'Output Files',
  '附件': 'Attachments',
  '上传文件': 'Upload File',
  '选择文件夹后可以 @ 引用项目文件': 'Choose a folder to @ mention project files',
  '@ 提及': '@ Mention',
  '点击加载': 'Click to Load',
  '打开 Agent 详情': 'Open Agent Details',
  '更多操作': 'More Actions',
  '复制消息': 'Copy Message',
  '转发的消息': 'Forwarded Message',
  '取消回复': 'Cancel Reply',
  '回复': 'Reply',
  '转发': 'Forward',
  '已归档': 'Archived',
  '已归档对话': 'Archived Chats',
  '暂无已归档的聊天。': 'No archived chats.',
  '未命名聊天': 'Untitled Chat',
  '偏好': 'Preferences',
  '管理当前设备上的 Janus 偏好。': 'Manage Janus preferences on this device.',
  '关闭最后一个窗口时': 'When closing the last window',
  '关闭窗口时': 'When closing a window',
  '后台运行': 'Keep Running',
  '退出 Janus': 'Quit Janus',
  '菜单栏': 'menu bar',
  '通知区域': 'notification area',
  '系统托盘': 'system tray',
  '菜单栏图标不可用': 'Menu bar icon unavailable',
  '通知区域图标不可用': 'Notification area icon unavailable',
  '系统托盘不可用': 'System tray unavailable',
  'Janus 将继续运行并保留在菜单栏': 'Janus will keep running in the menu bar.',
  'Janus 将继续运行并保留在通知区域': 'Janus will keep running in the notification area.',
  'Janus 将继续运行并保留在系统托盘': 'Janus will keep running in the system tray.',
  'Janus 将继续运行，可从 Dock 重新打开': 'Janus will keep running and can be reopened from the Dock.',
  '后台运行当前不可用，关闭最后一个窗口时 Janus 将退出': 'Background mode is currently unavailable. Janus will quit when its last window is closed.',
  'Janus 将结束本机任务并退出': 'Janus will stop local tasks and quit.',
  '关闭窗口后将在后台继续运行。': 'Janus will keep running in the background after its window is closed.',
  '关闭最后一个窗口后将退出 Janus。': 'Janus will quit after its last window is closed.',
  '无法更新窗口关闭行为。': 'Could not update the window close behavior.',
  '主题与语言': 'Appearance',
  '调整界面主题和显示语言。': 'Choose the app theme and display language.',
  '主题': 'Theme',
  '语言': 'Language',
  '浅色': 'Light',
  '深色': 'Dark',
  '明亮、适合日间工作。': 'Bright and comfortable for daytime work.',
  '降低夜间和暗光环境的视觉刺激。': 'Reduces glare in dark environments.',
  '英文': 'English',
  '中文': 'Chinese',
  '默认语言，文案更紧凑。': 'Default language with compact labels.',
  '使用简体中文界面。': 'Use the Simplified Chinese interface.',
  '账户与权限': 'Account',
  '普通成员': 'Member',
  '管理员': 'Administrator',
  '成员': 'Member',
  '创建者': 'Owner',
  '工作群成员': 'Workgroup Members',
  '查看工作群参与人': 'View Workgroup Participants',
  '任务已保留，成员上线后自动补派': 'The task is reserved and will be dispatched when this member comes online.',
  '待上线补派': 'Pending Online Dispatch',
  '计划参与人': 'Planned Participant',
  '本地 Agent': 'Local Agent',
  '外观': 'Appearance',
  '能力': 'Capabilities',
  '连接': 'Connections',
  '飞书连接': 'Feishu Connection',
  '支持': 'Support',
  '诊断与日志': 'Diagnostics',
  '技能与插件': 'Skills & Plugins',
  '自进化与同步': 'Evolution & Sync',
  '组织消息调查': 'Org Research',
  '自进化与更新': 'Evolution & Updates',
  '个人 Agent 版本': 'Personal Agent Versions',
  '仅在你点击后检查云端；检查不会发起进化任务，也不会自动更新。': 'Cloud checks run only when requested; they do not start evolution tasks or apply updates automatically.',
  '检测云端更新': 'Check Cloud Updates',
  '检测云端更新后，这里会列出人才市场中的全部 Agent Skill。': 'After checking the cloud, all Agent Skills from the Talent catalog will appear here.',
  '尚未检查云端更新。点击“检测云端更新”后，可在这里选择下载版本或回退。': 'Cloud updates have not been checked yet. Select “Check Cloud Updates” to download a version or roll back here.',
  '公司集群 Skill': 'Organization Skill Catalog',
  '云端按 Agent Family 聚合匿名证据并发布市场版本；你可以查看全部人才，并为已招募 Agent 选择 Skill。': 'The cloud aggregates anonymous evidence by Agent family and publishes shared versions for review and selection.',
  '候选版本需由你明确选择后才会下载并启用；历史稳定版本和基础 Skill 可随时回退。': 'Candidate versions are downloaded and enabled only after you choose them; stable history and base Skills remain available for rollback.',
  '查看进化记录与 Memory': 'View Evolution History & Memory',
  '管理账号、个人资料、模型服务和安全设置。': 'Manage your profile, model service, access, and security.',
  '安装和管理扩展能力；技能数量增加后可按状态和类别快速筛选。': 'Install and manage extensions, then filter them by status or category.',
  '查看、恢复或删除已归档的聊天。': 'Review, restore, or delete archived chats.',
  '查看或恢复已归档的聊天。': 'Review or restore archived chats.',
  '归档群聊': 'Archive Group Chat',
  '已解散群聊': 'Dissolved Group Chat',
  '查看本机日志状态，或导出脱敏诊断日志用于问题排查。': 'Review local logs or export a redacted diagnostic report.',
  '检测个人与公司 Skill 更新，并管理各 Agent 的云端同步。': 'Check Skill updates and manage cloud sync for each Agent.',
  '上传合规风控': 'Upload Compliance Controls',
  '拒传检测与账号停用': 'Upload Failure Detection & Account Suspension',
  '云端记录连续空同步和长期无有效上传，达到阈值后可自动停用账号。': 'The cloud tracks repeated empty syncs and prolonged upload inactivity, and can automatically suspend accounts after the threshold is reached.',
  '刷新列表': 'Refresh List',
  '当前状态': 'Current Status',
  '检测规则': 'Detection Rules',
  '空同步 / 长期无有效上传': 'Empty Sync / Prolonged Upload Inactivity',
  '未配置 Cloud Sync': 'Cloud Sync Not Configured',
  '暂无异常记录': 'No Anomalies',
  '当前未配置云端同步，因此无法读取风控列表。在 Cloud Sync 配置好 serverUrl 和管理员 token 后，这里会显示可疑或已停用的账号。': 'Cloud Sync is not configured, so the compliance list cannot be loaded. After configuring the server URL and administrator token, suspicious or suspended accounts will appear here.',
  '配置云端同步后可查看上传合规记录。': 'Configure Cloud Sync to view upload compliance records.',
  '正在读取上传合规记录…': 'Loading upload compliance records…',
  '暂无需处理的上传合规记录。': 'No upload compliance records require attention.',
  '模型服务': 'Model Service',
  '安全设置': 'Security',
  '个人资料': 'Profile',
  '登录': 'Sign In',
  'Janus 用户登录': 'Sign in to Janus',
  '注册': 'Create Account',
  '账号': 'Account',
  '邮箱 / 用户 ID': 'Email / User ID',
  '请输入密码': 'Enter your password',
  '注册 Janus 账号': 'Create a Janus Account',
  '返回登录': 'Back to Sign In',
  '验证码将发送到你的邮箱，验证通过后才能完成注册。': 'We will email you a code to verify your account.',
  '显示名称': 'Display Name',
  '可选': 'Optional',
  '请输入邮箱': 'Enter your email',
  '请输入邮箱。': 'Enter your email.',
  '邮箱格式不正确，请检查后重试。': 'The email format is invalid. Check the address and try again.',
  '该邮箱尚未注册。': 'No account is registered with this email.',
  '该邮箱已被注册，请直接登录或使用其他邮箱。': 'This email is already registered. Sign in or use another email.',
  '该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。': 'This email does not exist or cannot receive messages. Check the address and try again.',
  '验证码邮件发送失败，请稍后重试；如果持续失败，请确认邮箱能够正常收件。': 'The verification email could not be sent. Try again later and confirm that the mailbox can receive messages.',
  '请输入邮箱验证码。': 'Enter the email verification code.',
  '邮箱验证码应为 6 位数字。': 'The email verification code must contain 6 digits.',
  '邮箱验证码已过期，请重新获取。': 'The email verification code has expired. Request a new one.',
  '邮箱验证码不正确。': 'The email verification code is incorrect.',
  '操作成功': 'Completed',
  '操作未完成': 'Action Not Completed',
  '账号或密码有误': 'Account or Password Incorrect',
  '账号或密码不正确。': 'The account or password is incorrect.',
  '请检查邮箱或用户 ID，以及密码是否输入正确。': 'Check your email or user ID and password.',
  '邮箱尚未验证': 'Email Not Verified',
  '邮箱尚未验证，请先完成邮箱验证。': 'Your email has not been verified yet.',
  '请先完成邮箱验证，再重新登录。': 'Verify your email, then sign in again.',
  '该邮箱已注册': 'Email Already Registered',
  '可直接返回登录，或使用其他邮箱。': 'Return to sign in or use another email.',
  '验证码已过期': 'Verification Code Expired',
  '请重新获取验证码后再试。': 'Request a new code and try again.',
  '验证码不正确': 'Incorrect Verification Code',
  '请使用最近一封邮件中的 6 位验证码。': 'Use the 6-digit code from the latest email.',
  '请检查验证码': 'Check the Verification Code',
  '请输入邮件中的 6 位数字验证码。': 'Enter the 6-digit code from the email.',
  '请检查邮箱': 'Check Your Email',
  '请输入完整、有效的邮箱地址。': 'Enter a complete, valid email address.',
  '请输入账号': 'Enter Your Account',
  '请输入邮箱或用户 ID。': 'Enter your email or user ID.',
  '可以使用注册邮箱或用户 ID 登录。': 'Use your registered email or user ID to sign in.',
  '请输入密码。': 'Enter your password.',
  '密码至少需要 8 位。': 'The password must be at least 8 characters.',
  '密码必须同时包含字母和数字。': 'The password must contain both letters and numbers.',
  '密码至少需要 8 位，并同时包含字母和数字。': 'Use at least 8 characters with both letters and numbers.',
  '已登录。': 'Signed in.',
  '账号已创建并登录。': 'Account created. You are now signed in.',
  '未找到该账号': 'Account Not Found',
  '请检查邮箱，或先创建一个新账号。': 'Check the email or create a new account.',
  '邮箱无法接收验证码': 'Email Cannot Receive Codes',
  '请检查地址是否拼写正确，或更换可正常收件的邮箱。': 'Check the address or use another working mailbox.',
  '验证码发送失败': 'Could Not Send Code',
  '请稍后重试；若仍失败，请确认邮箱可以正常收件。': 'Try again later and confirm that the mailbox can receive mail.',
  '请检查密码': 'Check Your Password',
  '密码至少需要 8 位，并请确认输入完整。': 'Use at least 8 characters and enter the full password.',
  '两次密码不一致': 'Passwords Do Not Match',
  '请重新输入确认密码，确保与上方密码完全相同。': 'Re-enter the confirmation to match the password above.',
  '无法连接账号服务': 'Cannot Reach Account Service',
  '账号服务暂时无法访问。': 'The account service is temporarily unavailable.',
  '请检查网络连接，稍后重试。': 'Check your connection and try again shortly.',
  '无法登录': 'Could Not Sign In',
  '请检查输入内容后重试。': 'Check your details and try again.',
  '无法完成注册': 'Could Not Create Account',
  '请检查注册信息后重试。': 'Check your registration details and try again.',
  '请检查邮箱地址或稍后重试。': 'Check the email address or try again later.',
  '无法重置密码': 'Could Not Reset Password',
  '请检查邮箱、验证码和新密码后重试。': 'Check the email, code, and new password, then try again.',
  '密码已重置': 'Password Reset',
  '现在可以使用新密码登录。': 'You can now sign in with your new password.',
  '为了账号安全，请勿与他人共享密码。': 'Keep your password private to protect your account.',
  '验证码已发送': 'Verification Code Sent',
  '验证码仍然有效': 'Verification Code Still Valid',
  '已发送至': 'Sent to',
  '注册验证码已发送至': 'Registration code sent to',
  '重置密码验证码已发送至': 'Password reset code sent to',
  '修改密码验证码已发送至': 'Password change code sent to',
  '请检查邮箱获取验证码。': 'Check your inbox for the verification code.',
  '请使用最近一次收到的邮件。验证码 10 分钟内有效，仅可使用一次。': 'Use the latest email. The code is valid for 10 minutes and can be used once.',
  '10 分钟内有效，仅可使用一次。没有收到时请检查垃圾邮件。': 'Valid for 10 minutes and one use. Check spam if it does not arrive.',
  '请输入初始密码。': 'Enter an initial password.',
  '请再次输入密码。': 'Enter the password again.',
  '两次输入的密码不一致。': 'The passwords do not match.',
  '邮箱验证码': 'Email Code',
  '初始密码': 'Initial Password',
  '确认密码': 'Confirm Password',
  '再次输入密码': 'Enter the password again',
  '注册并登录': 'Create Account & Sign In',
  '重置密码': 'Reset Password',
  '通过邮箱验证码确认身份，然后设置新密码。': 'Verify your identity by email, then set a new password.',
  '请输入注册邮箱': 'Enter your registration email',
  '验证码仅可使用一次，请在 10 分钟内完成验证。': 'The code can be used once and expires in 10 minutes.',
  '退出登录': 'Sign Out',
  '邮箱': 'Email',
  '密码': 'Password',
  '验证码': 'Verification Code',
  '发送验证码': 'Send Code',
  '忘记密码': 'Forgot Password',
  '昵称': 'Display Name',
  '备注': 'Note',
  '保存并测试': 'Save & Test',
  '保存并测试通过': 'Saved and Tested',
  '仅保存在当前设备': 'Stored only on this device',
  '打开日志目录': 'Open Log Folder',
  '导出诊断日志': 'Export Diagnostics',
  '本机应用日志': 'Local Application Logs',
  '日志仅保存在本机，默认不记录对话、Prompt、模型回答或文件内容，也不会自动上传。': 'Logs stay on this device. By default they exclude chats, prompts, model responses, and file contents, and are never uploaded automatically.',
  '正常运行': 'Working Normally',
  '不可用': 'Unavailable',
  '日志等级': 'Log Level',
  '保留期限': 'Retention',
  '文件数量': 'Files',
  '占用空间': 'Storage Used',
  '最近写入': 'Last Write',
  '尚无记录': 'No Records Yet',
  '丢弃事件': 'Dropped Events',
  '最近写入错误': 'Latest Write Error',
  '导出文件默认为': 'The default export name is',
  '，保存位置可在系统下载目录中选择。': ', and you can choose its location in the system download folder.',
  '清理旧日志': 'Clear Old Logs',
  '正在导出…': 'Exporting…',
  '正在清理…': 'Cleaning…',
  '正在加载...': 'Loading...',
  '正在加载已归档对话...': 'Loading archived chats...',
  '加载失败': 'Load Failed',
  '同步中': 'Syncing',
  '状态未知': 'Unknown',
  '在线': 'Online',
  '离线': 'Offline',
  '离线数据': 'Offline Data',
  '本地': 'Local',
  '待查看': 'Ready',
  '运行中': 'Running',
  '处理中': 'Working',
  '已完成': 'Completed',
  '处理失败': 'Failed',
  '已取消': 'Cancelled',
  '等待同步': 'Waiting to Sync',
  '专业 Agent': 'Specialist Agent',
  'Agent 会话': 'Agent Chat',
  '点击进入会话': 'Open Conversation',
  '空闲': 'Idle',
  '空闲；单击查看详情，双击开始聊天，右键管理': 'Idle; click for details, double-click to chat, right-click to manage',
  '左键对话，右键管理': 'Click to chat; right-click to manage',
  '左键重新启用，右键管理': 'Click to reactivate; right-click to manage',
  '左键刷新状态并对话，右键管理': 'Click to refresh and chat; right-click to manage',
  '工作中': 'Working',
  '已预留': 'Reserved',
  '排队中': 'Queued',
  '执行中': 'Running',
  '受阻': 'Blocked',
  '可开始新的任务': 'Ready for a New Task',
  '任务信息更新中': 'Updating Task Details',
  '更新时间未知': 'Update Time Unknown',
  '需关注': 'Needs Attention',
  '暂无消息': 'No messages yet',
  '暂无联系人': 'No contacts yet',
  '暂无群组': 'No groups yet',
  '暂无进行中的任务': 'No active tasks',
  '暂无未读': 'No unread messages',
  '开始群聊': 'Start a Group Chat',
  '工作群已创建': 'Workgroup Created',
  '正在打开群聊': 'Opening Group Chat',
  '正在打开工作群': 'Opening Workgroup',
  '请稍候。': 'One moment…',
  '搜索结果': 'Search Results',
  '没有匹配的联系人、群聊或组织': 'No matching contacts, groups, or organizations.',
  '管理组织': 'Manage Organization',
  '加入组织': 'Join Organization',
  '任选一种方式即可加入': 'Choose Either Method to Join',
  '“组织号 + 邀请码”和“分享链接”是两种独立方式，不需要同时填写。': '“Organization ID + invite code” and “share link” are separate methods; you only need one.',
  '方式一': 'Method 1',
  '使用组织号和邀请码': 'Use Organization ID & Invite Code',
  '向组织创建者获取这两项信息': 'Get both from the organization owner',
  '方式二': 'Method 2',
  '或者': 'or',
  '粘贴组织分享链接': 'Paste an Organization Share Link',
  '链接中已包含加入所需的信息': 'The link already contains the information needed to join',
  '组织分享链接': 'Organization Share Link',
  '分享链接包含邀请码，请仅使用可信成员发送的链接。': 'Share links contain an invite code. Use links only from trusted members.',
  '使用分享链接加入': 'Join with Share Link',
  '创建组织': 'Create Organization',
  '组织信息': 'Organization Info',
  '组织偏好': 'Organization Preferences',
  '组织与通讯录': 'Organization & Contacts',
  '组织管理': 'Organization',
  '账户页面章节': 'Account page sections',
  '页面章节': 'On this page',
  '跳转到章节': 'Jump to section',
  '默认组织': 'Default Organization',
  'Janus 下次启动时自动进入': 'Open automatically the next time Janus starts',
  '设该组织为默认工作空间': 'Set This Organization as the Default Workspace',
  '加入后立即切换，并在下次启动时默认进入': 'Switch immediately after joining and open it by default the next time Janus starts.',
  '组织已加入，但保存默认工作空间失败。': 'The organization was joined, but the default workspace could not be saved.',
  '保存默认组织失败。': 'Could not save the default organization.',
  '当前组织': 'Current Organization',
  '切换为组织': 'Switch to organization',
  '暂无其他可切换组织': 'No other organizations available',
  '当前组织设置': 'Current Organization Settings',
  '尚未加入': 'Not Joined',
  '创建或加入组织后，可在这里查看组织号、管理邀请码并设置默认组织。': 'Create or join an organization to view its ID, manage invite codes, and choose the default organization.',
  '邀请码': 'Invite Code',
  '分享链接': 'Share Link',
  '链接管理': 'Link Management',
  '邀请码修改后，需要重新生成分享链接。': 'Regenerate the share link after changing the invite code.',
  '重新生成分享链接': 'Regenerate Share Link',
  '生成分享链接': 'Generate Share Link',
  '查看分享链接': 'View Share Link',
  '组织号': 'Organization ID',
  '管理当前组织': 'Manage Current Org',
  '切换到此组织': 'Switch to This Org',
  '已设为默认': 'Set as Default',
  '设为默认组织': 'Make Default',
  '未设置': 'Not Set',
  '当前使用': 'In Use',
  '切换工作空间': 'Workspaces',
  '选择工作空间': 'Choose Workspace',
  '最近使用': 'Recently Used',
  '更多工作空间': 'More Workspaces',
  '其他工作空间': 'Other Workspaces',
  '最近使用的组织': 'Recently Used Organizations',
  '更多组织': 'More Organizations',
  '其他组织': 'Other Organizations',
  '当前组织 · 默认组织': 'Current · Default',
  '当前组织 · 默认': 'Current · Default',
  'Janus 启动时自动进入该组织；临时切换不会改变此设置': 'Janus opens this organization at startup; temporary switches do not change it.',
  '尚未加入组织': 'No org joined',
  '前往创建、加入或设置组织': 'Create, join, or manage an organization',
  '若退出该组织，将自动选择其他有效组织': 'Leaving this organization automatically selects another available workspace.',
  '更新中心': 'Update Center',
  '一次检查软件与 Agent 实验室；软件下载和安装重启分开进行，安装前会再次确认。': 'Check the app and Agent Lab together. Download and restart are separate, with confirmation before installation.',
  '查看更新日志': 'View Release Notes',
  '检查最新版本': 'Check for Updates',
  '软件与 Agent 实验室共用统一版本序列；实验室更新会在后台自动校验并应用。': 'The app and Agent Lab share one version stream; Lab updates are verified and applied in the background.',
  '自动显示更新公告': 'Show Update Notices Automatically',
  '关闭后仍会检查更新，并在更新中心显示；只是不再主动弹窗。': 'Updates are still checked and shown in Update Center, but notices will not pop up automatically.',
  '当前安装包没有可用的内置模型凭据，请联系管理员。': 'This build has no embedded model credentials. Contact your administrator.',
  '试用版使用安装包预设的模型配置': 'Trial builds use the model configuration bundled with the installer.',
  '选择一张图片作为账号头像，侧栏和聊天中会同步显示': 'Choose an account avatar shown in the sidebar and chats.',
  '选择图片': 'Choose Image',
  '移除头像': 'Remove Avatar',
  '下载头像': 'Download Avatar',
  '头像已保存。': 'Avatar saved.',
  '头像已移除。': 'Avatar removed.',
  '头像下载已开始。': 'Avatar download started.',
  '显示名称（对外展示）': 'Display Name',
  '好友、组织和聊天中看到的名字，支持中文，也可以与其他人重复': 'The name shown to contacts and organizations; duplicates are allowed.',
  '例如：张三': 'For example: Alex',
  '注册邮箱用于登录和安全验证，不支持直接修改': 'Your registration email is used for sign-in and security checks and cannot be changed directly.',
  '账号名（唯一 @ 标识）': 'Username (unique @ handle)',
  '用于登录、搜索和添加联系人；仅支持小写字母、数字和下划线，对外展示使用昵称': 'Used for sign-in and contact search. Use lowercase letters, numbers, and underscores.',
  '例如：janus_user': 'For example: janus_user',
  '更新后会立即写入本地账号信息': 'Changes are saved to the local account immediately.',
  '安全': 'Security',
  '当前密码': 'Current Password',
  '验证当前登录密码': 'Verify your current sign-in password.',
  '新密码': 'New Password',
  '至少 8 位，包含字母和数字': 'At least 8 characters with letters and numbers',
  '至少 8 位': 'At least 8 characters',
  '发送至 当前账号邮箱': 'Send to the current account email',
  '6 位验证码': '6-digit code',
  '获取验证码': 'Get Code',
  '发送中…': 'Sending…',
  '重新发送': 'Resend',
  '下次登录时使用新密码': 'Use the new password next time you sign in.',
  '修改': 'Change',
  '仅退出当前设备，不会删除本地工作区数据': 'Signs out on this device without deleting local workspace data.',
  '切换主题': 'Switch Theme',
  '切换明暗主题': 'Toggle Light/Dark Theme',
  '切换侧边栏': 'Toggle Sidebar',
  '收起侧栏': 'Collapse Sidebar',
  '展开消息分组': 'Expand Message Groups',
  '标记为已完成': 'Mark as Completed',
  '调整消息列表宽度': 'Resize Message List',
  '后退': 'Back',
  '前进': 'Forward',
  '最小化': 'Minimize',
  '最大化': 'Maximize',
  '应用菜单': 'Application Menu',
  '应用导航': 'Application Navigation',
  '工作空间': 'Workspace',
  '工作空间与组织管理': 'Workspace & Organization',
  '新建聊天': 'New Chat',
  '新建项目': 'New Project',
  '打开设置': 'Open Settings',
  '收起': 'Collapse',
  '展开': 'Expand',
  '查看详情': 'View Details',
  '查看结果': 'View Result',
  '立即开始': 'Start Now',
  '去创建群聊': 'Create a Group',
  '用uBuddy开始协作': 'Start with uBuddy',
  '任务进度': 'Task Progress',
  '任务记录': 'Task History',
  '群聊设置': 'Group Settings',
  '查看群聊信息': 'View Group Info',
  '发起私聊': 'Start Direct Chat',
  '简介': 'Profile',
  '我': 'Me',
  '你': 'You',
  '刘思杰': 'Sijie Liu',
  '思杰': 'Sijie',
  '刘思': 'Sijie',
  '优秀的你，值得一朵小红花': 'You deserve a little celebration.',
  '从左侧选择一个会话，安静地继续沟通。': 'Choose a conversation on the left to continue.',
  '选择一个会话，开始协作': 'Choose a conversation to collaborate',
  '沟通、任务与 Agent 执行都会在同一条消息流里持续更新。': 'Messages, tasks, and Agent work stay in one live thread.',
  '开始新会话': 'Start New Chat',
  '先把复杂的事，说清楚': 'Start by making the complex clear',
  'uBuddy 会帮你整理目标，并找到合适的 Agent 一起完成。': 'uBuddy organizes your goal and brings in the right Agents to help.',
  '找 uBuddy 整理': 'Plan with uBuddy',
  '正在打开 uBuddy…': 'Opening uBuddy…',
  '裁剪头像': 'Crop Avatar',
  '头像预览': 'Avatar Preview',
  '查看头像': 'View Avatar',
  '缩放': 'Zoom',
  '使用头像': 'Use Avatar',
  '确认并继续': 'Confirm & Continue',
  '当前无法提交，请稍后再试。': 'Unable to submit right now. Please try again later.',
  '正在重新生成…': 'Regenerating…',
  '正在取消…': 'Cancelling…',
  '消息默认页': 'Messages Home',
  '切换默认页风格': 'Switch Home Style',
  '调整默认页顺序': 'Reorder Home Pages',
  '默认页顺序': 'Home Page Order',
  '拖动小图调整': 'Drag thumbnails to reorder',
  '上一页': 'Previous Page',
  '下一页': 'Next Page',
  '上一页，首尾循环': 'Previous Page, Wrap Around',
  '下一页，首尾循环': 'Next Page, Wrap Around',
  '小红花': 'Celebration',
  '协作': 'Collaboration',
  'PPT通用风格Agent': 'General PPT Agent',
  '通用PPT风格': 'General PPT Style',
  '学术汇报风格': 'Academic Report Style',
  '重大项目风格': 'Major Project Style',
  '通用PPT': 'General PPT',
  '通用 PPT': 'General PPT',
  '通用': 'General',
  '学术汇报风': 'Academic Report',
  '学术汇报': 'Academic Report',
  '重大项目风': 'Major Project',
  '重大项目汇报': 'Major Project Report',
  '不指定固定风格，按主题、听众和模板生成通用演示文稿。': 'Build a flexible presentation around the topic, audience, and selected template.',
  '面向课程汇报、论文讲解和技术科普，突出清晰结构、严谨方法与证据链条。': 'For coursework, papers, and technical talks, emphasizing structure, methods, and evidence.',
  '面向项目申报、实施方案、阶段评审和验收汇报，突出目标、技术路线、交付成果与风险控制。': 'For proposals, implementation plans, and project reviews, emphasizing goals, delivery routes, outcomes, and risks.',
  '面向论文、课题和技术汇报，强调逻辑、方法和结果表达。': 'Designed for papers, research, and technical reports, with clear methods and results.',
  '面向重大项目、工程建设和综合汇报，强调目标、路线和成效。': 'Designed for major projects and engineering reviews, with clear goals, plans, and outcomes.',
  '我的员工': 'My Agents',
  '在职员工': 'Active Agents',
  '已停用员工': 'Inactive Agents',
  '暂无在职员工': 'No active Agents yet',
  '暂无已停用员工': 'No inactive Agents',
  '专业人才': 'Specialists',
  '前往安装': 'Install Skill',
  '安装 Skill': 'Install Skill',
  'Skill 暂不可安装': 'Skill Currently Unavailable',
  '查看 Skill': 'View Skill',
  '必须先安装该 Skill，安装完成后才可招募此 Agent。': 'Install this Skill before hiring the Agent.',
  '该员工来自旧版招募记录；安装完成前不能进入聊天和任务候选池。': 'This Agent was hired in an earlier version and cannot join chats or task routing until the required Skill is installed.',
  '请先在本机安装该 Agent 所需的 Skill，安装完成后再招募。': 'Install the required Skill on this device before hiring the Agent.',
  '接收方设备缺少 PPT 制作 Skill': 'The Recipient Device Is Missing the PPT Creation Skill',
  '接收方没有已启用的 PPT Agent': 'The Recipient Has No Active PPT Agent',
  '安装 PPT 制作 Skill': 'Install PPT Creation Skill',
  'Skill 已安装，重新调度 Agent': 'Skill Installed, Dispatch Again',
  '筛选人才': 'Filter Talent',
  '按部门筛选人才': 'Filter Talent by Department',
  '更多操作': 'More Actions',
  '查看详情': 'View Details',
  '招募': 'Hire',
  '再招募': 'Hire Another',
  '再招募一名': 'Hire Another',
  '招募人才': 'Hire Agent',
  '员工额度': 'Agent Capacity',
  '员工额度使用进度': 'Agent capacity usage',
  '员工额度已满': 'Agent Limit Reached',
  '当前员工额度已满': 'The Agent limit has been reached.',
  '正在刷新 Skill 状态…': 'Refreshing Skill Status…',
  'Skill 已安装，正在刷新招募状态': 'Skill installed · Refreshing hiring status',
  '状态同步中…': 'Syncing Status…',
  '员工状态正在同步': 'Agent status is syncing',
  '暂不可招募': 'Hiring Unavailable',
  '该 Agent 当前暂不可招募': 'This Agent is currently unavailable for hiring.',
  '登录后招募': 'Sign In to Hire',
  '登录并连接云端后可招募': 'Sign in and connect to the cloud to hire this Agent.',
  '招募服务同步中…': 'Syncing Hiring Service…',
  '招募服务状态正在同步': 'Hiring service status is syncing',
  '招募状态尚未就绪': 'Hiring status is not ready yet.',
  '正在处理当前员工操作': 'Processing this Agent action',
  '正在处理其他员工操作': 'Processing another Agent action',
  '可继续招募': 'More Can Be Hired',
  '当前额度已满': 'Current Limit Reached',
  '招募后创建独立实例、Memory 与个人进化档案': 'Hiring creates a separate Agent, Memory, and growth record.',
  '查看人才介绍、核心能力与 Skill 信息。': 'Review this Agent’s profile, core capabilities, and Skill details.',
  '核心能力': 'Core Capabilities',
  'Skill 与实例': 'Skill & Instance',
  '专业执行': 'Specialist Execution',
  '检索、筛选并整理学术资料与研究脉络。': 'Find, filter, and organize academic sources and research context.',
  '分析数据问题，设计可执行的数据处理路径。': 'Analyze data problems and design practical processing workflows.',
  '协助论文结构、论证与成稿表达。': 'Shape paper structure, reasoning, and final writing.',
  '规划横向项目方案、交付与协作节奏。': 'Plan project delivery, collaboration, and execution cadence.',
  '将内容整理为清晰、可编辑的演示文稿。': 'Turn content into a clear, editable presentation.',
  '预览当前有效 Skill 归纳出的能力，并管理随 Skill 演进的本机版本与公开授权。': 'Preview capabilities derived from active Skills, then manage local versions and sharing permissions.',
  '本地预览当前有效 Skill 所表达的能力与边界；不会保存或发布。': 'Preview the capabilities and limits expressed by active Skills; nothing is saved or published.',
  '查看随有效 Skill 演进的历史版本，并审核公开范围与隐私风险。': 'Review profile history as Skills evolve, including sharing scope and privacy risks.',
  '正在读取 uBuddy 简介历史...': 'Loading uBuddy profile history...',
  '本机版本历史': 'Local Version History',
  '简介随 Skill 异步更新': 'Profile Updates with Skills',
  'Skill 激活不等待简介；生成或验证失败时继续使用上一版。': 'Skill activation does not wait for the profile; the last version remains active if generation or validation fails.',
  '已有生效版本': 'Active Version Available',
  '等待生成': 'Waiting to Generate',
  '公开设置': 'Sharing Settings',
  '尚未授权公开；所有版本仅保存在本机': 'Sharing is off; every version stays on this device.',
  '根据当前 Skill 重新生成': 'Regenerate from Current Skills',
  '停止公开': 'Stop Sharing',
  '版本历史': 'Version History',
  '尚无简介版本。打开本页后会按当前有效 Skill 异步生成第一版。': 'No profile versions yet. The first version will be generated from active Skills in the background.',
  '草稿': 'Draft',
  '已验证': 'Validated',
  '当前生效': 'Active',
  '当前组合': 'Current Combination',
  '市场基础': 'Market Base',
  '个人叠加': 'Personal Overlay',
  '未使用': 'Not Used',
  '已生效': 'Active',
  '市场版本提供共享基础；个人版本仅调整这个 Agent 的专属工作方式。': 'Market versions provide the shared base; personal versions customize only this Agent’s working style.',
  '选择共享市场基础，并按需叠加只属于这个 Agent 的个人版本。': 'Choose a shared market base and optionally add a personal version for this Agent only.',
  '市场版本': 'Market Versions',
  '同类 Agent 共享的能力基础': 'Shared capability base for Agents of this type',
  '我的版本': 'My Versions',
  '只属于这个 Agent 实例，不会影响其他同类 Agent': 'Applies only to this Agent and does not affect other Agents of the same type',
  '不使用个人版本': 'No Personal Version',
  '只使用所选市场基础': 'Use Only the Selected Market Base',
  '不会删除个人版本，之后可以随时重新选择。': 'Personal versions are kept and can be selected again at any time.',
  '取消个人叠加': 'Remove Personal Overlay',
  'Agent 自带的稳定能力': 'Stable Built-in Agent Capabilities',
  '不叠加市场更新；个人版本仍可独立使用。': 'Do not apply market updates; personal versions remain available independently.',
  '使用基础版': 'Use Base Version',
  '使用此版本': 'Use This Version',
  '招募后可选': 'Available After Hiring',
  '暂不可用': 'Temporarily Unavailable',
  '当前没有其他市场版本。': 'No other market versions are available.',
  'Skill 版本': 'Skill Versions',
  '关闭 Skill 版本': 'Close Skill Versions',
  '返回 Agent 概览': 'Back to Agent Overview',
  '返回员工详情': 'Back to Agent Details',
  '历史归档': 'Archived',
  '已拒绝': 'Rejected',
  '简介正在后台生成，Skill 已正常生效。': 'The profile is being generated in the background; Skills are already active.',
  '检测到隐私风险': 'Privacy Risk Detected',
  '需要人工确认': 'Review Required',
  '能力范围或公开边界发生变化。': 'The capability scope or sharing boundary changed.',
  '拒绝': 'Reject',
  '正在根据当前有效 Skill 生成简介...': 'Generating a profile from active Skills...',
  '暂时无法读取简介预览。': 'The profile preview is temporarily unavailable.',
  '重新生成': 'Regenerate',
  '仅本机预览': 'Local Preview Only',
  '完整生成暂时不可用，已显示基础介绍；uBuddy 的任务处理不受影响。': 'Full generation is unavailable, so a basic profile is shown; uBuddy task handling is unaffected.',
  '内容由当前有效 Skill 自动归纳，未读取 Memory、私聊或附件。': 'This summary uses active Skills only; it does not read Memory, private chats, or attachments.',
  '基础介绍': 'Basic Profile',
  '生成成功': 'Generated',
  '格式化 JSON': 'Format JSON',
  '擅长的任务类型': 'Best-Suited Tasks',
  '能力标签': 'Capability Tags',
  '偏好的任务': 'Preferred Tasks',
  '不适合或不支持': 'Unsupported or Poor-Fit Tasks',
  '需要改进的方向': 'Areas to Improve',
  '支持的协作方式': 'Supported Collaboration',
  '隐私及对外承诺限制': 'Privacy & External Commitment Limits',
  '能力证据摘要': 'Capability Evidence',
  '任务澄清与需求整理': 'Task & Requirement Clarification',
  '上下文意图理解': 'Contextual Intent Understanding',
  '信息整理与文档起草': 'Information Organization & Drafting',
  '直接问答与轻量分析': 'Direct Q&A & Light Analysis',
  '任务分派与协作协调': 'Task Delegation & Coordination',
  '跨用户委托协调': 'Cross-User Delegation',
  '进度跟踪与状态汇报': 'Progress Tracking & Status Updates',
  '结果版本管理': 'Result Version Management',
  '失败恢复与阻塞说明': 'Failure Recovery & Blocker Reporting',
  '受控文件与项目工作': 'Controlled File & Project Work',
  '演示文稿任务协调': 'Presentation Coordination',
  '表格任务协调': 'Spreadsheet Coordination',
  '代码任务协调': 'Code Task Coordination',
  '图像与视觉任务协调': 'Image & Visual Coordination',
  '翻译与语言转换': 'Translation & Language Conversion',
  '经确认的结果提交': 'Confirmed Result Submission',
  '隐私边界控制': 'Privacy Boundary Control',
  '需求整理': 'Requirements',
  '意图理解': 'Intent Understanding',
  '文档整理': 'Document Drafting',
  '分析与问答': 'Analysis & Q&A',
  '协作协调': 'Coordination',
  '跨用户协作': 'Cross-User Collaboration',
  '进度跟踪': 'Progress Tracking',
  '版本控制': 'Version Control',
  '失败恢复': 'Failure Recovery',
  '文件工作': 'File Work',
  '代码协作': 'Code Collaboration',
  '视觉内容': 'Visual Content',
  '翻译': 'Translation',
  '提交控制': 'Submission Control',
  '隐私保护': 'Privacy Protection',
  '把口头需求整理为目标、约束、交付物和验收要点。': 'Turn verbal requests into goals, constraints, deliverables, and acceptance criteria.',
  '结合当前上下文理解指代、版本和真实操作意图。': 'Use context to resolve references, versions, and intended actions.',
  '整理摘要、说明、需求文档、会议纪要和检查清单。': 'Draft summaries, specifications, requirement documents, meeting notes, and checklists.',
  '处理职责范围内的问答、研究整理和轻量分析。': 'Handle in-scope Q&A, research synthesis, and light analysis.',
  '选择合适的执行者并协调单 Agent 或多 Agent 任务。': 'Select the right executors and coordinate single- or multi-Agent tasks.',
  '整理并跟进经确认的跨用户委托。': 'Organize and follow up on confirmed cross-user delegations.',
  '跟踪负责人、依赖、阻塞和下一步决策。': 'Track owners, dependencies, blockers, and next decisions.',
  '识别当前有效结果并避免提交失败、过期或错误版本。': 'Identify the valid result and avoid failed, outdated, or incorrect versions.',
  '在失败或阻塞时保留上下文并给出可执行的恢复路径。': 'Preserve context and provide actionable recovery steps when blocked.',
  '在有效工作区和明确边界内处理低风险文件任务。': 'Handle low-risk file work within a valid workspace and clear boundaries.',
  '协调演示文稿的内容准备、制作与验收。': 'Coordinate presentation preparation, production, and review.',
  '协调结构化表格的整理、生成与校验。': 'Coordinate structured spreadsheet organization, generation, and validation.',
  '协调代码修改、验证和交付。': 'Coordinate code changes, verification, and delivery.',
  '协调图像或视觉类产物的生成与验收。': 'Coordinate creation and review of image or visual deliverables.',
  '处理明确范围内的翻译与语言转换。': 'Handle clearly scoped translation and language conversion.',
  '在所有者确认后提交或共享已验证的有效结果。': 'Submit or share verified results after owner confirmation.',
  '按批准的接收方和目的最小化披露信息。': 'Minimize disclosure based on approved recipients and purposes.',
  'uBuddy 直接处理': 'Handled Directly by uBuddy',
  '转交单个 specialist Agent': 'Assign to One Specialist Agent',
  '协调多 Agent 任务': 'Coordinate Multi-Agent Tasks',
  '经确认的跨用户委托': 'Confirmed Cross-User Delegation',
  '任务群共享工作区协作': 'Shared Task-Group Workspace',
  '转交合适的 Agent': 'Assign to a Suitable Agent',
  '把口头需求整理为清晰任务。': 'Turn verbal requests into clear tasks.',
  '协调合适的执行者并跟进结果。': 'Coordinate the right executors and follow through on results.',
  '系统未明确支持或无法验证结果的日历、消息、文件和执行操作。': 'Calendar, messaging, file, or execution actions that are not explicitly supported or verifiable.',
  '未经所有者明确确认的对外发布、正式承诺或结果提交。': 'External publishing, formal commitments, or result submission without explicit owner confirmation.',
  '需要专用专业产物管线且不应由 uBuddy 直接冒充完成的任务。': 'Tasks requiring a specialist delivery pipeline that uBuddy should not imitate directly.',
  '缺少有效项目工作区时的本地文件创建或修改。': 'Creating or modifying local files without a valid project workspace.',
  '要求披露私有对话、Memory、凭据、未发布材料或无关本地信息的任务。': 'Tasks requiring disclosure of private chats, Memory, credentials, unpublished material, or unrelated local data.',
  '超出已验证能力边界且无法安全转交的任务。': 'Tasks beyond verified capabilities that cannot be delegated safely.',
  '未经确认的对外发布、正式承诺或信息共享。': 'Unconfirmed external publishing, formal commitments, or information sharing.',
  '要求披露私有信息、凭据或未发布材料的任务。': 'Tasks requiring disclosure of private information, credentials, or unpublished material.',
  '简介仅根据当前有效 Skill 生成，不读取私有 Memory、私聊或附件内容。': 'The profile uses active Skills only and does not read private Memory, chats, or attachments.',
  '仅向获批接收方披露完成任务所必需的信息。': 'Disclose only the information necessary to approved recipients.',
  '对外发布、正式承诺和共享结果前需要所有者明确确认。': 'Owner confirmation is required before publishing, making commitments, or sharing results.',
  '不公开本地绝对路径、凭据、未发布材料或内部执行信息。': 'Do not expose local absolute paths, credentials, unpublished material, or internal execution details.',
  '对外共享前需要所有者明确确认。': 'Owner confirmation is required before external sharing.',
  '扩大经有效 Skill 明确验证的专业任务覆盖。': 'Expand specialist task coverage explicitly validated by active Skills.',
  '减少不必要澄清，同时保持关键约束完整。': 'Reduce unnecessary clarification while preserving key constraints.',
  '提升复杂任务路由和执行者匹配的一致性。': 'Improve consistency in complex-task routing and executor matching.',
  '继续提高状态核验和有效结果选择的准确性。': 'Improve the accuracy of status verification and valid-result selection.',
  '提升复杂任务路由、状态核验和交付验收的一致性。': 'Improve consistency in complex-task routing, status verification, and delivery review.',
  '我的 uBuddy 是专业私人秘书与任务协调入口，可帮助整理需求、协调执行并跟进结果。': 'My uBuddy is a professional private secretary and task-coordination hub for organizing requirements, coordinating execution, and following up on results.',
  '完整简介暂时无法生成；当前显示不含私有内容的基础能力说明。': 'The full profile is temporarily unavailable; this basic capability summary contains no private content.',
  '直接答复': 'Direct Answer',
  '报告': 'Report',
  '文档': 'Document',
  '演示文稿': 'Presentation',
  '表格': 'Spreadsheet',
  '图像': 'Image',
  '代码修改': 'Code Change',
  '可交付成果类型': 'Deliverable Types',
  '状态：不持久化 · 不发布': 'Status: not saved · not published',
  '生成中…': 'Generating…',
  '正在生成…': 'Generating…',
  'PPT 制作技能': 'PPT Creation Skill',
  '内容创作': 'Content Creation',
  '生成通用、学术汇报和重大项目等可编辑 PPT。': 'Create editable PPT presentations for general, academic, and major-project use.',
  '为统一的 PPT Designer 安装三种正式风格、可编辑 PPTX 渲染能力、模板支持和预览导出流程。': 'Adds three presentation styles, editable PPTX rendering, templates, previews, and export.',
  '演示设计': 'Presentation Design',
  '3 种风格': '3 Styles',
  '可编辑 PPTX': 'Editable PPTX',
  '模板与预览': 'Templates & Previews',
  '读取用户明确提供的演示素材': 'Read presentation assets explicitly provided by the user',
  '在当前工作区生成 PPTX 与预览文件': 'Create PPTX and preview files in the current workspace',
  '技能概览': 'Skills Overview',
  '插件与技能': 'Plugins & Skills',
  '扩展总数': 'Total Extensions',
  '技能总数': 'Total Skills',
  '类别': 'Category',
  '排序': 'Sort',
  '每个技能独立安装，不占用人才配额。': 'Each Skill installs independently and does not use the Agent quota.',
  '搜索技能与插件': 'Search Skills & Plugins',
  '按名称搜索插件与技能': 'Search plugins and Skills by name',
  '搜索期间自动展开': 'Expanded automatically while searching',
  'Janus 自研技能': 'Janus Skills',
  '独立 Skills': 'Standalone Skills',
  '加载更多': 'Load More',
  '已显示': 'Showing',
  'Codex 插件': 'Codex Plugins',
  '按当前账号安装，所有本地 uBuddy 与 Agent 会话均可使用。': 'Installed for this account and available to all local uBuddy and Agent conversations.',
  '实际 Codex CLI': 'Active Codex CLI',
  '插件最低版本': 'Minimum Plugin Version',
  'Janus 内置': 'Bundled with Janus',
  '自定义配置': 'Custom Configuration',
  '系统环境': 'System Environment',
  '未识别': 'Unrecognized',
  '推荐': 'Recommended',
  '检测到旧 GitHub MCP 配置': 'Legacy GitHub MCP Configuration Detected',
  '它不是 Codex Plugin，不会显示在插件目录或 @ 列表中。现有 MCP 配置已保留，请安装下方推荐的 GitHub Plugin。': 'This is not a Codex Plugin and will not appear in the plugin catalog or @ list. The existing MCP configuration was preserved; install the recommended GitHub Plugin below.',
  '当前 Codex CLI 不可用。请重新安装或升级 Janus。': 'The Codex CLI is unavailable. Reinstall or upgrade Janus.',
  '无法确认当前 Codex CLI 版本。请重新安装或升级 Janus。': 'The Codex CLI version could not be verified. Reinstall or upgrade Janus.',
  '当前 Codex CLI 未提供完整的 Plugin 管理命令。请升级或重新安装 Janus。': 'The current Codex CLI does not provide the complete Plugin management commands. Upgrade or reinstall Janus.',
  'Marketplace 来源': 'Marketplace Source',
  '本地目录、owner/repo 或 Git URL': 'Local directory, owner/repo, or Git URL',
  '本地目录或 owner/repository': 'Local directory or owner/repository',
  '选择目录': 'Choose Directory',
  '添加市场': 'Add Marketplace',
  '更新 marketplace': 'Update Marketplace',
  '移除 marketplace': 'Remove Marketplace',
  '由 Codex 提供默认官方 marketplace。': 'Codex provides the default official marketplace.',
  '当前 marketplace 中没有匹配的插件。': 'No matching plugins are available in the current marketplaces.',
  '官方': 'Official',
  '第三方': 'Third Party',
  '未知来源': 'Unknown Source',
  '安装时认证': 'Authenticate on Install',
  '使用时认证': 'Authenticate on Use',
  '无需额外认证': 'No Additional Authentication',
  '禁用': 'Disabled',
  'Codex 扩展能力': 'Codex Extension',
  '所选插件': 'Selected plugin',
  '搜索名称、类别或能力': 'Search by name, category, or capability',
  '筛选技能': 'Filter Skills',
  '已安装': 'Installed',
  '可安装': 'Available',
  '全部类别': 'All Categories',
  '推荐顺序': 'Recommended',
  '名称': 'Name',
  '已安装技能': 'Installed Skills',
  '可安装技能': 'Available Skills',
  '技能目录': 'Skill Catalog',
  '没有匹配的技能或插件。': 'No matching Skills or plugins.',
  '还没有安装任何扩展技能。': 'No extension Skills are installed yet.',
  '当前没有新的可安装技能。': 'No new Skills are available to install.',
  '技能目录暂时为空。': 'The Skill catalog is currently empty.',
  '正在检测安装状态': 'Checking Installation',
  '技能已下载': 'Skill Downloaded',
  '未下载': 'Not Downloaded',
  '等待检测': 'Waiting for Check',
  '扩展能力': 'Extension',
  '安装': 'Install',
  '安装中...': 'Installing...',
  '卸载': 'Uninstall',
  '关闭插件详情': 'Close Plugin Details',
  '关闭人才详情': 'Close Talent Details',
  '人才介绍': 'Talent Profile',
  'Agent 类型': 'Agent Type',
  '当前实例': 'Current Instances',
  '每次招募都会创建新的独立实例，并按 A/B/C… 初始化名称。基础与市场 Skill 按类型共享；Memory、会话、备注、个人进化与成长记录按实例隔离。': 'Each hire creates an independent instance named A/B/C… Base and market Skills are shared by type, while Memory, chats, notes, personal evolution, and growth records stay isolated per instance.',
  '暂无能力说明。': 'No capability details.',
  '不提供独立 Agent。': 'No standalone Agent included.',
  '无需额外权限。': 'No additional permissions required.',
  '来源': 'Source',
  '依赖': 'Dependencies',
  '立即使用': 'Use Now',
});

const ENGLISH_FRAGMENTS = Object.freeze([
  ['任务执行失败诊断', 'Task Execution Failure Diagnostics'],
  ['打开任务可查看最后一次报错和失败节点。', 'Open the task to view the latest error and failed node.'],
  ['查看失败原因', 'View Failure Details'],
  ['任务未完成', 'Task Not Completed'],
  ['该失败节点没有可用的命令执行记录。', 'No command execution records are available for this failed node.'],
  ['查看完整输出', 'View Full Output'],
  ['最后一次报错', 'Latest Error'],
  ['退出码', 'Exit Code'],
  ['无输出', 'No Output'],
  ['原生文本差异已按正文行展示。', 'Native text changes are shown line by line.'],
  ['运行了多个命令', 'Ran Multiple Commands'],
  ['运行了 1 个命令', 'Ran 1 Command'],
  ['本轮统一差异', 'Unified Diff for This Turn'],
  ['最终回答事件', 'Final Answer Event'],
  ['待依赖/待执行', 'Waiting / Pending'],
  ['排队/运行中', 'Queued / Running'],
  ['等待上一轮完成', 'Waiting for the Previous Turn'],
  ['当前职级不允许跨部门', 'Current Level Does Not Allow Cross-Department Work'],
  ['缺少试岗监督批准', 'Missing Trial Supervisor Approval'],
  ['缺少治理批准', 'Missing Governance Approval'],
  ['上游原始协议', 'Raw Upstream Protocol'],
  ['普通优先级', 'Normal Priority'],
  ['等待对方处理', 'Waiting for the Other Person'],
  ['等待接收方 uBuddy', 'Waiting for the Recipient’s uBuddy'],
  ['等待对方 uBuddy 接收', 'Waiting for the Other uBuddy'],
  ['等待发起人验收', 'Waiting for Requester Acceptance'],
  ['对方 uBuddy 准备初稿', 'The Other uBuddy Is Preparing a Draft'],
  ['来自发起方的新要求', 'New Requirements from the Requester'],
  ['离线缓存已过期', 'Offline Cache Expired'],
  ['等待用户选择', 'Waiting for User Choice'],
  ['写入同步数据', 'Write Sync Data'],
  ['批准新设备', 'Approve New Device'],
  ['leader 已唤醒 uBuddy', 'Leader Woke uBuddy'],
  ['Leader 已唤醒 uBuddy', 'Leader Woke uBuddy'],
  ['需要用户处理', 'User Action Required'],
  ['等待空闲', 'Waiting Until Available'],
  ['本地隔离 · 仅你可见', 'Local Isolation · Private'],
  ['方案格式未通过检查', 'Plan Format Check Failed'],
  ['方案完整性未通过检查', 'Plan Completeness Check Failed'],
  ['负责人派发 · 发起人协调', 'Owner Dispatch · Requester Coordination'],
  ['等待依赖', 'Waiting for Dependencies'],
  ['页面配图', 'Slide Visuals'],
  ['页面制作', 'Slide Production'],
  ['排版自检', 'Layout Review'],
  ['持续处理', 'Continuing'],
  ['命中缓存', 'Cache Hit'],
  ['遇到阻塞', 'Blocked'],
  ['用量受限', 'Usage Limited'],
  ['思考过程', 'Reasoning Process'],
  ['引用的记忆', 'Referenced Memory'],
  ['工具服务', 'Tool Service'],
  ['工具名称', 'Tool Name'],
  ['检索动作', 'Search Action'],
  ['路由原因', 'Routing Reason'],
  ['接收线程', 'Receiving Thread'],
  ['安全缓冲', 'Safety Buffer'],
  ['审核元数据', 'Review Metadata'],
  ['命令执行 · 等待批准', 'Command Execution · Waiting for Approval'],
  ['命令执行 · 需检查', 'Command Execution · Needs Review'],
  ['命令执行 · 等待处理', 'Command Execution · Waiting'],
  ['解析后的命令动作', 'Parsed Command Actions'],
  ['有问题，尽管问', 'Ask Anything'],
  ['本轮估算', 'This Turn Estimate'],
  ['替我审批', 'Approve for Me'],
  ['隔离空间内执行', 'Run in Isolated Space'],
  ['仅在私人助理隔离目录内自动执行，不开放全盘访问', 'Run automatically only in the private-assistant directory; full-disk access remains disabled'],
  ['使用无学校标识的通用多功能页面库，按每页 layout_id 选取模板页。', 'Use the general slide library without school branding and select each template by layout_id.'],
  ['使用哈尔滨工业大学（深圳）多功能页面库，按每页 layout_id 选取模板页。', 'Use the HITSZ slide library and select each template by layout_id.'],
  ['使用华南理工大学多功能页面库，按每页 layout_id 选取模板页。', 'Use the SCUT slide library and select each template by layout_id.'],
  ['当前存在阻塞，系统会按恢复策略继续处理。', 'A blocker is present. The system will continue according to the recovery policy.'],
  ['最近一次执行问题', 'Latest Execution Issue'],
  ['已批准待领取', 'Approved, Waiting to Claim'],
  ['已停止再次领取', 'Further Claims Disabled'],
  ['共享内测 Key 已写入当前设备。', 'The shared beta key was saved on this device.'],
  ['再次领取资格已停止；如果此前已领取，旧 Key 仍需通过共享 Key 轮换才能真正失效。', 'Further claims are disabled. Previously claimed keys remain active until the shared key is rotated.'],
  ['推理强度', 'Reasoning Effort'],
  ['证据门槛、隐私过滤、Gate、回归和结构校验', 'Evidence thresholds, privacy filters, Gate checks, regression, and structural validation'],
  ['lightweight classifier + 可选 LLM 校正', 'Lightweight classifier + optional LLM refinement'],
  ['当前不参与正式路由。', 'Not currently included in production routing.'],
  ['单用户权重不超过 15% · 发布章节至少需要 3 位用户证据支持。', 'Single-user weight is capped at 15% · Published sections require evidence from at least 3 users.'],
  ['等待沟通', 'Waiting for Communication'],
  ['就绪队列', 'Ready Queue'],
  ['发出方验收', 'Requester Acceptance'],
  ['等待 / 阻塞', 'Waiting / Blocked'],
  ['执行思考', 'Execution Reasoning'],
  ['工作目录', 'Working Directory'],
  ['终端输入', 'Terminal Input'],
  ['工具参数', 'Tool Parameters'],
  ['命令动作', 'Command Actions'],
  ['原始响应', 'Raw Response'],
  ['低优先级', 'Low Priority'],
  ['高优先级', 'High Priority'],
  ['等待补传', 'Waiting to Upload'],
  ['交给我的', 'Assigned to Me'],
  ['我发起的', 'Started by Me'],
  ['需要修正', 'Needs Revision'],
  ['我的 uBuddy · 协调整理', 'My uBuddy · Coordinated'],
  ['我的 uBuddy', 'My uBuddy'],
  ['的 uBuddy', "'s uBuddy"],
  ['前往任务工作区', 'Open task workspace'],
  ['最终目标', 'Final Objective'],
  ['任务目标', 'Objective'],
  ['交付物', 'Deliverables'],
  ['验收标准', 'Acceptance criteria'],
  ['约束', 'Constraints'],
  ['截止时间', 'Deadline'],
  ['执行 Agent', 'Execution Agent'],
  ['接收方 uBuddy（Agent 待分配）', "Recipient's uBuddy (Agent pending)"],
  ['uBuddy 已整理', 'Organized by uBuddy'],
  ['打回重做', 'Request Rework'],
  ['初稿已就绪', 'Draft Ready'],
  ['待我验收', 'Waiting for My Acceptance'],
  ['uBuddy 准备初稿', 'uBuddy Is Preparing a Draft'],
  ['uBuddy 接收中', 'uBuddy Is Receiving'],
  ['来自云端', 'From Cloud'],
  ['部分应用', 'Partially Applied'],
  ['尚未应用', 'Not Applied Yet'],
  ['未知原因', 'Unknown Reason'],
  ['数据同步', 'Data Sync'],
  ['密钥恢复', 'Key Recovery'],
  ['云端接口', 'Cloud API'],
  ['uBuddy 验收中', 'uBuddy Is Reviewing'],
  ['审核终止', 'Review Stopped'],
  ['未完成', 'Incomplete'],
  ['个人演化', 'Personal Evolution'],
  ['复制回答', 'Copy Answer'],
  ['明确单人', 'Explicit Single Participant'],
  ['用户要求全员', 'User Requested Everyone'],
  ['多人候选', 'Multiple Candidates'],
  ['参与人选择', 'Participant Selection'],
  ['未知用户', 'Unknown User'],
  ['其他用户', 'Other User'],
  ['请求批准', 'Request Approval'],
  ['后端裁决', 'Backend Decision'],
  ['数据边界', 'Data Boundaries'],
  ['演示流程', 'Demo Workflow'],
  ['维护运行', 'Maintenance Run'],
  ['提案待应用', 'Proposal Pending'],
  ['草案待应用', 'Draft Pending'],
  ['无已应用变化', 'No Applied Changes'],
  ['招聘新 agent', 'Recruit New Agent'],
  ['拆分新 agent', 'Split into a New Agent'],
  ['合并 agent', 'Merge Agents'],
  ['开除/退休 agent', 'Remove/Retire Agent'],
  ['候选 agent 晋升', 'Candidate Agent Promotion'],
  ['治理事件', 'Governance Events'],
  ['所需技能', 'Required Skills'],
  ['等待数据', 'Waiting for Data'],
  ['首次通过', 'First-Pass Success'],
  ['执行效率', 'Execution Efficiency'],
  ['拆解匹配', 'Decomposition Match'],
  ['命令', 'Command'],
  ['浏览器', 'Browser'],
  ['工具', 'Tool'],
  ['成功', 'Success'],
  ['移动', 'Moved'],
  ['等待批准', 'Waiting for Approval'],
  ['已阻止', 'Blocked'],
  ['参数', 'Parameters'],
  ['检索词', 'Search Query'],
  ['请求类型', 'Request Type'],
  ['原因', 'Reason'],
  ['位置', 'Location'],
  ['决定', 'Decision'],
  ['提示', 'Prompt'],
  ['代码审查', 'Code Review'],
  ['上下文处理', 'Context Processing'],
  ['运行环境', 'Runtime Environment'],
  ['等待', 'Waiting'],
  ['协议事件', 'Protocol Event'],
  ['心跳', 'Heartbeat'],
  ['可执行', 'Runnable'],
  ['已排队', 'Queued'],
  ['待执行', 'Pending'],
  ['职级不足', 'Level Too Low'],
  ['输出', 'Output'],
  ['未分配', 'Unassigned'],
  ['已续接', 'Continued'],
  ['已暂停', 'Paused'],
  ['等待中', 'Waiting'],
  ['可工作', 'Available'],
  ['已解决', 'Resolved'],
  ['已过期', 'Expired'],
  ['紧急', 'Urgent'],
  ['已发布', 'Published'],
  ['开始处理', 'Start Processing'],
  ['已接收', 'Received'],
  ['待接收', 'Waiting to Receive'],
  ['拉黑', 'Block'],
  ['用户', 'User'],
  ['已撤回', 'Withdrawn'],
  ['已派发', 'Dispatched'],
  ['已验收', 'Accepted'],
  ['等待验收', 'Waiting for Acceptance'],
  ['私聊', 'Direct Chat'],
  ['已移动', 'Moved'],
  ['标题', 'Heading'],
  ['段落', 'Paragraph'],
  ['列表', 'List'],
  ['已领取', 'Claimed'],
  ['待决定', 'Waiting for Decision'],
  ['已应用', 'Applied'],
  ['有效', 'Valid'],
  ['已撤销', 'Revoked'],
  ['追加', 'Append'],
  ['替换', 'Replace'],
  ['变更', 'Changes'],
  ['你：', 'You:'],
  ['我的', 'Mine'],
  ['有冲突', 'Conflict'],
  ['只读', 'Read Only'],
  ['共享', 'Shared'],
  ['等待启动', 'Waiting to Start'],
  ['准备执行', 'Preparing to Run'],
  ['待处理', 'Pending'],
  ['调整中', 'Revising'],
  ['友', 'Contact'],
  ['调研', 'Research'],
  ['问答', 'Q&A'],
  ['准备中', 'Preparing'],
  ['配图', 'Visuals'],
  ['制作', 'Production'],
  ['自检', 'Review'],
  ['已处理', 'Processed'],
  ['问题', 'Question'],
  ['警告', 'Warning'],
  ['原始命令', 'Raw Command'],
  ['需处理', 'Needs Action'],
  ['压缩中…', 'Compressing…'],
  ['上下文', 'Context'],
  ['下周', 'Next Week'],
  ['受限', 'Limited'],
  ['无项目', 'No Project'],
  ['超高', 'Very High'],
  ['规划', 'Planning'],
  ['执行', 'Execution'],
  ['验证', 'Validation'],
  ['运行', 'Running'],
  ['排队', 'Queued'],
  ['正常', 'Normal'],
  ['观察中', 'Watching'],
  ['可疑', 'Suspicious'],
  ['已是最新', 'Up to Date'],
  ['等待检查', 'Waiting for Check'],
  ['等待选择', 'Waiting for Selection'],
  ['审核中', 'Under Review'],
  ['未通过', 'Not Approved'],
  ['检查中', 'Checking'],
  ['应用中', 'Applying'],
  ['已就绪', 'Ready'],
  ['待检查', 'Needs Check'],
  ['招聘', 'Recruitment'],
  ['开除', 'Removal'],
  ['晋升', 'Promotion'],
  ['考核', 'Review'],
  ['部门', 'Department'],
  ['可靠性', 'Reliability'],
  ['正在同步', 'Syncing'],
  ['正在加载', 'Loading'],
  ['正在打开', 'Opening'],
  ['正在处理', 'Working'],
  ['正在生成', 'Generating'],
  ['已完成', 'Completed'],
  ['已结束', 'Ended'],
  ['已解散', 'Dissolved'],
  ['进行中', 'Active'],
  ['暂无', 'No '],
  ['未读消息', 'unread messages'],
  ['未读', 'unread'],
  ['位成员', ' members'],
  ['位联系人', ' contacts'],
  ['条消息', ' messages'],
  ['条未读消息', ' unread messages'],
  ['个会话', ' conversations'],
  ['个群组', ' groups'],
  ['个节点', ' nodes'],
  ['项进行中的任务', ' active tasks'],
  ['查看', 'View '],
  ['管理', 'Manage '],
  ['添加', 'Add '],
  ['创建', 'Create '],
  ['搜索', 'Search '],
  ['打开', 'Open '],
  ['关闭', 'Close '],
]);

const SKIP_LOCALIZATION_SELECTOR = [
  '[data-no-localize]',
  '.message-body',
  '.forwarded-message-content',
  '.message-quote',
  '.social-message-title',
  '.network-delegation-message-bubble',
  '.local-task-workspace-message > div',
  '.contact-profile-introduction',
  '.employee-memory-content',
  '.markdown-body',
  'pre',
  'code',
  'textarea',
  '[contenteditable="true"]',
].join(',');

export function normalizeLanguage(value = '') {
  return normalizeUiLanguage(value);
}


export function translateUiText(value = '', language = 'en') {
  if (normalizeLanguage(language) !== 'en') return String(value || '');
  const source = String(value || '');
  if (!/[\u3400-\u9fff]/.test(source)) return source;
  const leading = source.match(/^\s*/)?.[0] || '';
  const trailing = source.match(/\s*$/)?.[0] || '';
  const clean = source.trim();
  if (!clean) return source;
  let translated = ENGLISH_EXACT[clean] || translatePattern(clean);
  if (!translated) {
    translated = clean;
    for (const [from, to] of ENGLISH_FRAGMENTS) translated = translated.replaceAll(from, to);
    translated = translated
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (/[\u3400-\u9fff]/.test(translated)) translated = fallbackEnglishUiText(clean);
  return /[\u3400-\u9fff]/.test(translated) ? source : `${leading}${translated}${trailing}`;
}

export function installLocalizedNativeDialogs(windowRef, getLanguage = () => 'zh-CN') {
  if (!windowRef) return () => {};
  const installed = [];
  for (const method of ['confirm', 'alert', 'prompt']) {
    if (typeof windowRef[method] !== 'function') continue;
    const original = windowRef[method].bind(windowRef);
    const localized = (message, ...args) => original(translateUiText(message, getLanguage()), ...args);
    windowRef[method] = localized;
    installed.push([method, localized, original]);
  }
  return () => {
    for (const [method, localized, original] of installed) {
      if (windowRef[method] === localized) windowRef[method] = original;
    }
  };
}

export function translateUBuddyMessageText(value = '', language = 'en') {
  const source = String(value || '');
  if (normalizeLanguage(language) !== 'en' || !/[\u3400-\u9fff]/u.test(source)) return source;
  const exact = UBUDDY_ENGLISH_EXACT[source.trim()];
  if (exact) return `${source.match(/^\s*/)?.[0] || ''}${exact}${source.match(/\s*$/)?.[0] || ''}`;
  return source.split('\n').map(translateUBuddyMessageLine).join('\n');
}

function translateUBuddyMessageLine(value = '') {
  const leading = value.match(/^\s*/)?.[0] || '';
  const clean = value.trim();
  if (!clean) return value;
  if (UBUDDY_ENGLISH_EXACT[clean]) return `${leading}${UBUDDY_ENGLISH_EXACT[clean]}`;
  let match = clean.match(/^已停止任务“(.+)”。已完成内容会保留；如果需要，可以从任务卡重新执行。$/);
  if (match) return `${leading}Stopped task “${match[1]}.” Completed work has been preserved, and you can run it again from the task card.`;
  match = clean.match(/^已停止任务“(.+)”。已保存的历史版本仍可在任务工作区查看。$/);
  if (match) return `${leading}Stopped task “${match[1]}.” Saved historical versions remain available in the task workspace.`;
  match = clean.match(/^已将补充要求加入任务“(.+)”的 FIFO 队列，只会进入该任务。$/);
  if (match) return `${leading}Added the new requirements to the FIFO queue for task “${match[1]}.” They will only apply to that task.`;
  match = clean.match(/^已停止交给 (.+) 的任务。已完成内容会保留。$/);
  if (match) return `${leading}Stopped the task assigned to ${match[1]}. Completed work has been preserved.`;
  match = clean.match(/^任务已交给 (.+) 的单 Agent 工作区；没有创建任务图或任务群。$/);
  if (match) return `${leading}The task was sent to ${match[1]}'s single-Agent workspace. No task graph or task group was created.`;
  match = clean.match(/^(.+) 的 uBuddy 向我派发了任务“(.+)”。我已收到，接下来会在隔离工作区安排 Agent 执行。$/);
  if (match) return `${leading}${match[1]}'s uBuddy assigned me task “${match[2]}.” I received it and will arrange Agent execution in an isolated workspace.`;
  match = clean.match(/^(.+) 的 uBuddy 向我派发了任务“(.+)”，我已恢复该任务的执行进度。$/);
  if (match) return `${leading}${match[1]}'s uBuddy assigned me task “${match[2]}.” I restored its execution progress.`;
  match = clean.match(/^(.+) 的 uBuddy 向我派发了任务“(.+)”。我已收到，正在规划 Agent 和执行步骤。$/);
  if (match) return `${leading}${match[1]}'s uBuddy assigned me task “${match[2]}.” I received it and am planning the Agents and execution steps.`;
  match = clean.match(/^委托任务状态已更新：(.+)$/);
  if (match) return `${leading}Delegation status updated: ${match[1]}`;
  match = clean.match(/^Buddy agent 已提交任务结果，等待你验收：(.+)$/);
  if (match) return `${leading}The Buddy Agent submitted the task result for your review: ${match[1]}`;
  match = clean.match(/^Buddy agent 任务已完成：(.+)$/);
  if (match) return `${leading}Buddy Agent task completed: ${match[1]}`;
  match = clean.match(/^Buddy agent 任务(已拒绝|处理失败)：(.+)$/);
  if (match) return `${leading}Buddy Agent task ${match[1] === '已拒绝' ? 'declined' : 'failed'}: ${match[2]}`;
  match = clean.match(/^- (.+)（任务图 (.+)）$/);
  if (match) return `${leading}- ${match[1]} (task graph ${match[2]})`;
  match = clean.match(/^- (.+) 直接任务（(.+)）$/);
  if (match) return `${leading}- ${match[1]} direct task (${match[2]})`;
  match = clean.match(/^uBuddy 未能完成任务信息检查，因此没有创建任务、协作组或委托。请重试；错误信息：(.+)$/);
  if (match) return `${leading}uBuddy could not complete the task intake check, so no task, collaboration group, or delegation was created. Try again. Error: ${match[1]}`;
  match = clean.match(/^uBuddy 未能完成本次模型决策，因此没有创建任务，也没有使用旧规则自动降级。请重试；错误信息：(.+)$/);
  if (match) return `${leading}uBuddy could not complete the model decision, so no task was created and no legacy fallback was used. Try again. Error: ${match[1]}`;
  match = clean.match(/^我识别到你想发布委托，但没有收到结构化 @ 联系人。请从 @ 菜单选择已接受联系人后再发送。当前可委托好友：(.+)。$/);
  if (match) return `${leading}I detected a delegation request, but no structured @ contact was selected. Choose an accepted contact from the @ menu and send again. Available contacts: ${match[1]}.`;
  match = clean.match(/^当前可见任务列表只有 (\d+) 个任务，找不到第 (\d+) 个。$/);
  if (match) return `${leading}The current task list contains only ${match[1]} task${match[1] === '1' ? '' : 's'}; task ${match[2]} does not exist.`;
  match = clean.match(/^最近任务：$/);
  if (match) return `${leading}Recent tasks:`;
  match = clean.match(/^当前有 (\d+) 个相关任务：$/);
  if (match) return `${leading}${match[1]} related task${match[1] === '1' ? '' : 's'}:`;
  match = clean.match(/^任务“(.+)”当前状态：$/);
  if (match) return `${leading}Current status of task “${match[1]}”:`;
  match = clean.match(/^任务“(.+)”当前状态：(.+)。$/);
  if (match) return `${leading}Task “${match[1]}” is ${translateUBuddyStatus(match[2])}.`;
  match = clean.match(/^- (.+)：(.+)，已完成 (\d+)\/(\d+) 个节点。$/);
  if (match) return `${leading}- ${match[1]}: ${translateUBuddyStatus(match[2])}; ${match[3]}/${match[4]} nodes completed.`;
  match = clean.match(/^(?:- )?(.+?)，已完成 (\d+)\/(\d+) 个节点。$/);
  if (match) return `${leading}${clean.startsWith('- ') ? '- ' : ''}${translateUBuddyStatus(match[1].replace(/^- /, ''))}; ${match[2]}/${match[3]} nodes completed.`;
  match = clean.match(/^正在处理：(.+)。$/);
  if (match) return `${leading}In progress: ${match[1]}.`;
  match = clean.match(/^阻塞\/异常：(.+)。$/);
  if (match) return `${leading}Blocked or failed: ${translateUBuddyStatusFragments(match[1])}.`;
  match = clean.match(/^结果摘要：(.+)$/);
  if (match) return `${leading}Result summary: ${match[1]}`;
  match = clean.match(/^任务结果摘要：(.+)$/);
  if (match) return `${leading}Task result summary: ${match[1]}`;
  match = clean.match(/^- 当前任务没有记录可定位的结构化文件或产物。$/);
  if (match) return `${leading}- No locatable structured file or artifact is recorded for this task.`;
  match = clean.match(/^单 Agent 直接任务：$/);
  if (match) return `${leading}Direct single-Agent tasks:`;
  match = clean.match(/^- (.+)：(等待 Agent 领取|正在执行|已完成|执行失败|已停止|状态未知)(?:（(.+)）)?$/);
  if (match) return `${leading}- ${match[1]}: ${translateUBuddyStatus(match[2])}${match[3] ? ` (${match[3]})` : ''}`;
  match = clean.match(/^任务“(.+)”还没有进入 uBuddy 交付验收。$/);
  if (match) return `${leading}Task “${match[1]}” has not entered uBuddy delivery review yet.`;
  match = clean.match(/^任务“(.+)”的验收状态：(.+)。$/);
  if (match) return `${leading}Delivery review for task “${match[1]}”: ${translateUBuddyReviewStatus(match[2])}.`;
  match = clean.match(/^已保存 (\d+) 个交付版本；当前质量修改 (\d+)\/(\d+)。$/);
  if (match) return `${leading}${match[1]} delivery version${match[1] === '1' ? '' : 's'} saved; quality revisions: ${match[2]}/${match[3]}.`;
  match = clean.match(/^uBuddy 结论：(.+)$/);
  if (match) return `${leading}uBuddy conclusion: ${match[1]}`;
  match = clean.match(/^未通过项：(.+)$/);
  if (match) return `${leading}Failed checks: ${match[1]}`;
  match = clean.match(/^要求修改：(.+)$/);
  if (match) return `${leading}Required changes: ${match[1]}`;
  match = clean.match(/^当前最新保存版本：版本 (\d+)。你可以预览后说“采用最新版”，或明确说“采用第 (\d+) 版”。$/);
  if (match) return `${leading}Latest saved version: ${match[1]}. Preview it and say “Accept Latest Version,” or explicitly say “Accept Version ${match[2]}.”`;
  match = clean.match(/^没有找到版本 (\d+)。请在版本列表中选择已有版本。$/);
  if (match) return `${leading}Version ${match[1]} was not found. Select an existing version from the version list.`;
  match = clean.match(/^版本 (\d+) 已保留为外部委托交付候选。请回到委托任务点击“确认并交付到任务群”；任务最终是否结束由发出方验收或打回决定。$/);
  if (match) return `${leading}Version ${match[1]} has been retained as the external delegation delivery candidate. Return to the delegation task and choose “Confirm and Deliver to Task Group.” The requester will accept it or request revisions.`;
  match = clean.match(/^已接受版本 (\d+)；用户确认已记录，任务现已关闭。当前自动修改、验收和未完成节点均已停止。$/);
  if (match) return `${leading}Version ${match[1]} was accepted and the task is now closed. Automatic revisions, review, and unfinished nodes have stopped.`;
  match = clean.match(/^uBuddy 已生成第 (\d+) 版分工方案，尚未派发。$/);
  if (match) return `${leading}uBuddy generated assignment plan version ${match[1]}. It has not been dispatched.`;
  match = clean.match(/^协作模式：同事协作：发起人也参与工作$/);
  if (match) return `${leading}Collaboration mode: peer collaboration; the requester also participates.`;
  match = clean.match(/^协作模式：负责人派发：发起人只负责协调与最终汇总$/);
  if (match) return `${leading}Collaboration mode: owner delegation; the requester only coordinates and consolidates the final result.`;
  match = clean.match(/^最终整合：发起人的 uBuddy$/);
  if (match) return `${leading}Final consolidation: the requester’s uBuddy`;
  match = clean.match(/^请确认后再派发；也可以要求修改、改为全员参与或取消。$/);
  if (match) return `${leading}Confirm before dispatching. You can also request changes, include everyone, or cancel.`;
  match = clean.match(/^任务图已完成，leader（(.+)）已接管；uBuddy 现在休眠，完成、失败或需要你操作时会由 Scheduler 唤醒。(.*)$/);
  if (match) return `${leading}The task graph is complete. Leader ${match[1]} has taken over, and uBuddy is now sleeping until Scheduler wakes it for completion, failure, or required user action.${translateUBuddyOmission(match[2])}`;
  match = clean.match(/^任务图已完成并保存，正在等待符合要求的员工空闲。(.*)$/);
  if (match) return `${leading}The task graph is complete and saved. Waiting for an eligible Agent to become available.${translateUBuddyOmission(match[1])}`;
  match = clean.match(/^任务需要你的操作：(.+)$/);
  if (match) return `${leading}This task needs your action: ${match[1]}`;
  match = clean.match(/^任务(已完成|已停止|需要修正|执行失败)：(.+)$/);
  if (match) return `${leading}Task ${translateUBuddyStatus(match[1])}: ${match[2]}`;
  match = clean.match(/^(.+) 已完成任务：$/);
  if (match) return `${leading}${match[1]} completed the task:`;
  match = clean.match(/^(.+) 的结果需要修正：$/);
  if (match) return `${leading}${match[1]}'s result needs revision:`;
  match = clean.match(/^(.+) 的任务已停止。点击可打开该 Agent 会话查看详情。$/);
  if (match) return `${leading}${match[1]}'s task was stopped. Open the Agent conversation for details.`;
  match = clean.match(/^(.+) 执行失败：(.+)。点击可打开该 Agent 会话查看详情。$/);
  if (match) return `${leading}${match[1]} failed: ${match[2]}. Open the Agent conversation for details.`;
  match = clean.match(/^(\d+)\. (.+)（(.+)）$/);
  if (match) return `${leading}${match[1]}. ${match[2]} (${translateUBuddyStatus(match[3])})`;
  match = clean.match(/^(\d+)\. 你（由本地 uBuddy\/Agent 执行）：(.+)$/);
  if (match) return `${leading}${match[1]}. You (local uBuddy/Agent): ${match[2]}`;
  match = clean.match(/^(\d+)\. 参与人：(.+)$/);
  if (match) return `${leading}${match[1]}. Participant: ${match[2]}`;
  if (/^\d+\. /.test(clean) && clean.includes('；依赖：')) return `${leading}${clean.replace('；依赖：', '; dependencies: ')}`;
  return value;
}

function translateUBuddyStatusFragments(value = '') {
  let translated = String(value || '');
  for (const status of ['等待自动重试', '等待信息', '依赖失败阻塞', '受阻', '执行失败', '状态异常']) {
    translated = translated.replaceAll(`（${status}）`, `(${translateUBuddyStatus(status)})`);
  }
  return translated;
}

function translateUBuddyOmission(value = '') {
  const source = String(value || '');
  return source
    .replace(/^\s*未采用你提到的 Agent：/, ' Mentioned Agents not selected: ')
    .replace(/^\s*未调用你提到的 Agent：/, ' Mentioned Agents not called: ');
}

function translateUBuddyReviewStatus(value = '') {
  return ({
    '已提交': 'submitted', 'uBuddy 验收中': 'under uBuddy review', '等待修改': 'waiting for revision',
    'Agent 修改中': 'being revised by an Agent', '已交付': 'delivered', '需要用户处理': 'user action required',
    '自动修改次数已用尽': 'automatic revision limit reached', '验收终止': 'review stopped', '未知': 'unknown',
  })[String(value || '').trim()] || value;
}

function translateUBuddyStatus(value = '') {
  return ({
    '等待规划': 'waiting for planning', '等待执行': 'waiting to run', '已进入队列': 'queued', '执行中': 'running',
    '等待自动重试': 'waiting for automatic retry', '等待信息': 'waiting for information', '依赖失败阻塞': 'blocked by a failed dependency',
    '正在停止': 'stopping', '已完成': 'completed', '执行失败': 'failed', '已取消': 'cancelled', '状态未知': 'in an unknown state',
    '等待 Agent 领取': 'waiting for an Agent', '正在执行': 'running', '已停止': 'stopped',
    '需要修正': 'needs revision', '受阻': 'blocked', '状态异常': 'in an invalid state',
  })[String(value || '').trim()] || value;
}

function fallbackEnglishUiText(value = '') {
  const source = String(value || '').trim();
  if (!/[\u3400-\u9fff]/.test(source)) return source;
  const compact = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const number = compact.match(/\d+(?:\.\d+)?%?/)?.[0] || '';
  if (/正在|处理中|加载|载入|读取|同步中|生成中|提交中|保存中|刷新中|下载中|安装中|排队中|执行中/.test(compact)) return number ? `Working… ${number}` : 'Working…';
  if (/暂无|尚无|没有|未提供|未记录|不存在|空文件|空演示文稿|状态未知|时间未知/.test(compact)) return 'Nothing to show yet.';
  if (/失败|错误|异常|不可用|无法|拒绝|中断|受阻|未成功/.test(compact)) return 'The operation could not be completed.';
  if (/关闭/.test(compact)) return 'Close';
  if (/取消/.test(compact)) return 'Cancel';
  if (/返回|上一步/.test(compact)) return 'Back';
  if (/刷新|重新检查/.test(compact)) return 'Refresh';
  if (/重试/.test(compact)) return 'Retry';
  if (/删除|移除/.test(compact)) return 'Remove';
  if (/保存/.test(compact)) return 'Save';
  if (/提交|确认|采用|同意|接受/.test(compact)) return 'Confirm';
  if (/创建|新建|添加|加入|生成/.test(compact)) return 'Create';
  if (/打开|查看|详情/.test(compact)) return 'View Details';
  if (/搜索|查找/.test(compact)) return 'Search';
  if (/下载|导出/.test(compact)) return 'Download';
  if (/上传/.test(compact)) return 'Upload';
  if (/发送|回复|转发/.test(compact)) return 'Send';
  if (/编辑|修改|重命名/.test(compact)) return 'Edit';
  if (/任务|委托|协作|交付|节点|流程图|目标|计划/.test(compact)) return number ? `Task details · ${number}` : 'Task details';
  if (/组织|邀请码|管理员|群主|成员|联系人|好友|群组|群聊/.test(compact)) return number ? `Organization and contacts · ${number}` : 'Organization and contacts';
  if (/消息|对话|聊天|会话|未读/.test(compact)) return number ? `Conversation details · ${number}` : 'Conversation details';
  if (/Agent|员工|人才|Skill|Memory|能力|进化|Leadership/.test(compact)) return number ? `Agent details · ${number}` : 'Agent details';
  if (/更新|版本|公告|安装包/.test(compact)) return number ? `Update details · ${number}` : 'Update details';
  if (/文件|文档|图片|图像|幻灯片|表格|工作表|附件|PPT|Word|Excel|PDF/.test(compact)) return number ? `File details · ${number}` : 'File details';
  if (/登录|账号|账户|邮箱|密码|验证码|授权/.test(compact)) return 'Sign-in details';
  if (/设置|配置|Provider|Codex|模型|Reasoning|权限/.test(compact)) return 'Settings';
  if (/状态|进度|记录|历史|结果|内容|说明|信息|操作/.test(compact)) return number ? `Details · ${number}` : 'Details';
  return source;
}

export function translateUserVisibleError(value = '', language = 'en', error = null) {
  const source = String(value || '');
  const translated = translateUiText(source, language);
  if (normalizeLanguage(language) !== 'en' || !/[\u3400-\u9fff]/.test(translated)) return translated;
  return englishErrorFallback(error);
}

function translatePattern(value) {
  let match = value.match(/^(\d+)\/(\d+) 节点 · (\d+)%$/);
  if (match) return `${match[1]}/${match[2]} nodes · ${match[3]}%`;
  match = value.match(/^已停止 (\d+) 项任务并归档工作群。$/);
  if (match) return `Stopped ${match[1]} task${match[1] === '1' ? '' : 's'} and archived the work group.`;
  match = value.match(/^默认组织已设为 (.+)。$/);
  if (match) return `Default organization set to ${englishDynamicText(match[1], 'the selected organization', (name) => name)}.`;
  match = value.match(/^当前账号已经加入组织“(.+)”。$/);
  if (match) return `This account has already joined organization “${englishDynamicText(match[1], 'this organization', (name) => name)}”.`;
  match = value.match(/^当前 Codex CLI v([^ ]+) 过旧，插件功能需要 v([^ ]+) 或更高版本。请升级或重新安装 Janus。$/);
  if (match) return `Codex CLI v${match[1]} is too old. Plugin support requires v${match[2]} or newer. Upgrade or reinstall Janus.`;
  match = value.match(/^查看\s*(\d+)\s*位成员$/);
  if (match) return `View ${match[1]} members`;
  match = value.match(/^报错前最近 (\d+) 条命令$/);
  if (match) return `Latest ${match[1]} Commands Before the Error`;
  match = value.match(/^失败节点：(.+)$/);
  if (match) return `Failed Node: ${englishDynamicText(match[1], 'Task Node', (name) => name)}`;
  match = value.match(/^后续 (\d+) 个任务 · (.+)$/);
  if (match) return `${match[1]} queued task${match[1] === '1' ? '' : 's'} · ${translateUiText(match[2], 'en')}`;
  match = value.match(/^确认卸载(.+)？$/);
  if (match) return `Uninstall ${englishDynamicText(match[1], 'this Skill')}?`;
  match = value.match(/^确认归档项目“(.+)”？这个项目下的所有对话都会一起归档。$/);
  if (match) return `Archive ${englishDynamicText(match[1], 'this project', (name) => `project “${name}”`)}? All conversations in this project will be archived with it.`;
  match = value.match(/^确认删除“(.+)”？会话中的本地附件副本也会被永久删除；仍被其他会话引用的文件会保留。$/);
  if (match) return `Delete ${englishDynamicText(match[1], 'this conversation', (name) => `“${name}”`)}? Local attachment copies in this conversation will also be permanently deleted. Files referenced by other conversations will be kept.`;
  match = value.match(/^确认删除(.+)吗？原始聊天不会被删除。$/);
  if (match) return `Delete ${englishDynamicText(match[1], 'this item')}? The original chat will not be deleted.`;
  match = value.match(/^采用版本 (\d+) 后，当前自动修改、验收和未完成节点都会停止。确认采用吗？$/);
  if (match) return `Accept version ${match[1]}? Current automatic revisions, review, and unfinished nodes will stop.`;
  match = value.match(/^确认从失败节点“(.+)”继续吗？该节点成功后，系统会自动推进仍未完成的下游节点。$/);
  if (match) return `Continue from ${englishDynamicText(match[1], 'the failed node', (name) => `failed node “${name}”`)}? After it succeeds, Janus will automatically continue the unfinished downstream nodes.`;
  match = value.match(/^确认让该 Agent 进行一次 (.+) 受控试岗？本次最多协调 (\d+) 名 Agent。$/);
  if (match) return `Start a controlled ${englishDynamicText(match[1], 'leadership')} trial for this Agent? This trial can coordinate up to ${match[2]} Agents.`;
  match = value.match(/^委托给 (.+) 的秘书 Agent：任务标题$/);
  if (match) return `Delegate to ${englishDynamicText(match[1], 'the contact', (name) => name)}’s assistant Agent: task title`;
  match = value.match(/^发现 Janus 更新；部分检查失败：(.+)$/);
  if (match) return `A Janus update is available. Some checks failed: ${englishDynamicText(match[1], 'See Update Center for details.')}`;
  match = value.match(/^部分更新检查失败：(.+)$/);
  if (match) return `Some update checks failed: ${englishDynamicText(match[1], 'See Update Center for details.')}`;
  match = value.match(/^启动更新安装失败：(.+)$/);
  if (match) return `Could not start update installation: ${englishDynamicText(match[1], 'See Update Center for details.')}`;
  match = value.match(/^(.+)：(.+)$/);
  if (match && /更新下载失败/.test(match[1])) return `Update download failed: ${englishDynamicText(match[2], 'See Update Center for details.')}`;
  match = value.match(/^仍有 (\d+) 项任务未被接受。解散后这些任务也会关闭且内容变为只读。确定继续吗？$/);
  if (match) return `${match[1]} task${match[1] === '1' ? '' : 's'} have not been accepted. Dissolving the group will close them and make their content read-only. Continue?`;
  match = value.match(/^确认停用这名员工？\n\n(当前正在运行的工作不会被强制中止，但所有排队任务会立即取消。\n\n)?停用后会立即释放员工配额，并保留历史会话、Memory、Skill 与成长记录。之后可在消息页或人才市场重新启用。$/);
  if (match) return `Deactivate this Agent?\n\n${match[1] ? 'Running work will not be forcibly stopped, but all queued tasks will be cancelled.\n\n' : ''}Deactivation immediately releases the Agent quota while preserving conversation history, Memory, Skills, and growth records. You can reactivate the Agent later from Messages or Talent.`;
  let compatibilityMatch = value.match(/^此数据库需要 Janus (.+) 或更高版本；当前版本为 (.+)。为保护本地数据，快速修复已禁用。$/);
  if (compatibilityMatch) return `This database requires Janus ${compatibilityMatch[1]} or newer. The current version is ${compatibilityMatch[2]}. Quick Repair is disabled to protect your local data.`;
  compatibilityMatch = value.match(/^请安装 Janus (.+) 或更高版本。当前数据库不会被修改。$/);
  if (compatibilityMatch) return `Install Janus ${compatibilityMatch[1]} or newer. The current database will not be modified.`;
  const providerStatus = translateProviderStatusPattern(value);
  if (providerStatus) return providerStatus;
  match = value.match(/^(菜单栏图标|通知区域图标|系统托盘)不可用：(.+)$/);
  if (match) {
    const location = { '菜单栏图标': 'Menu bar icon', '通知区域图标': 'Notification area icon', '系统托盘': 'System tray' }[match[1]];
    return `${location} unavailable: ${match[2]}`;
  }
  match = value.match(/^正在重新连接模型服务（(\d+)\/(\d+)）$/);
  if (match) return `Reconnecting to the model service (${match[1]}/${match[2]})`;
  match = value.match(/^模型服务响应较慢，继续等待（(\d+)\/(\d+)）$/);
  if (match) return `The model service is responding slowly; continuing to wait (${match[1]}/${match[2]})`;
  match = value.match(/^(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})$/);
  if (match) return `${match[1]} to ${match[2]}`;
  match = value.match(/^已纳入 (\d+) 个结构化任务$/);
  if (match) return `${match[1]} structured task${match[1] === '1' ? '' : 's'} included`;
  match = value.match(/^等待截止：(.+)$/);
  if (match) return `Waiting period ends: ${match[1]}`;
  match = value.match(/^上游模型服务尚未返回输出；已等待约 ([\d.]+) 秒，Janus 将保留当前请求并继续等待模型运行时恢复连接。$/);
  if (match) return `The upstream model service has not returned output. Janus has waited about ${match[1]} seconds and will keep the current request open while the model runtime reconnects.`;
  match = value.match(/^上游模型服务尚未返回输出；已等待约 ([\d.]+) 秒，Janus 将保留当前请求并继续等待响应。$/);
  if (match) return `The upstream model service has not returned output. Janus has waited about ${match[1]} seconds and will keep the current request open while waiting for a response.`;
  match = value.match(/^(执行失败：)?(JanusUnavailable:\s*)?Janus 已连接本地模型运行时，但上游模型服务在连续 (\d+) 个等待周期内（每次 ([\d.]+) 秒，累计约 ([\d.]+) 秒）始终未返回任何模型输出。当前请求已停止；请检查网络或代理连接、API 配额以及模型服务状态后重试。$/);
  if (match) {
    const prefix = `${match[1] ? 'Execution failed: ' : ''}${match[2] || ''}`;
    return `${prefix}Janus connected to the local model runtime, but the upstream model service returned no output across ${match[3]} consecutive wait periods (${match[4]} seconds each, about ${match[5]} seconds total). The current request has been stopped. Check the network or proxy connection, API quota, and model service status, then try again.`;
  }
  match = value.match(/^问题\s*(\d+)\s*\/\s*(\d+)\s*·\s*可随时切换回 Janus 查看对话$/);
  if (match) return `Question ${match[1]} of ${match[2]} · You can return to Janus at any time`;
  match = value.match(/^(\d+)\s*条申请等待(处理|验证)$/);
  if (match) {
    const requestCount = `${match[1]} request${match[1] === '1' ? '' : 's'}`;
    return `${requestCount} awaiting ${match[2] === '处理' ? 'review' : 'verification'}`;
  }
  match = value.match(/^(.+)。参与人选择和任务要求已保留，且没有派发任何任务。$/);
  if (match) return `${translateUiText(match[1], 'en')}. The participant selection and task requirements have been preserved, and no task was dispatched.`;
  match = value.match(/^错误编号：(.+)$/);
  if (match) return `Error code: ${match[1]}`;
  match = value.match(/^已选择：(.+)$/);
  if (match) return `Selected: ${translateUiText(match[1], 'en')}`;
  match = value.match(/^(.+) · (\d+) 位成员，不含我$/);
  if (match) return `${match[1]} · ${match[2]} members, excluding me`;
  match = value.match(/^当前组织有 (\d+) 位可派发成员，超过单次上限 (\d+) 人，请分批选择联系人。$/);
  if (match) return `The current organization has ${match[1]} eligible recipients, exceeding the per-dispatch limit of ${match[2]}. Select contacts in smaller batches.`;
  match = value.match(/^(\d+)\s*秒后重发$/);
  if (match) return `Resend in ${match[1]}s`;
  match = value.match(/^(\d+)\s*条新进展\s*↓$/);
  if (match) return `${match[1]} new update${match[1] === '1' ? '' : 's'} ↓`;
  match = value.match(/^对话缩放\s*(\d+)%\s*(?:·\s*Ctrl\/⌘\+0\s*重置)?$/);
  if (match) return `Conversation zoom ${match[1]}%${Number(match[1]) === 100 ? '' : ' · Ctrl/⌘+0 to reset'}`;
  match = value.match(/^正在下载最新软件(?:，进度\s*(\d+(?:\.\d+)?)%)?；下载期间仍可继续使用。$/);
  if (match) return `Downloading the latest update${match[1] ? ` · ${match[1]}%` : ''}. You can keep using Janus during the download.`;
  match = value.match(/^请完成“(.+)”后再继续。$/);
  if (match) return `Complete “${translateUiText(match[1], 'en')}” before continuing.`;
  match = value.match(/^提交失败：(.+)$/);
  if (match) return `Submission failed: ${translateUserVisibleError(match[1], 'en')}`;
  match = value.match(/^申请添加\s+(.+)$/);
  if (match) return `Add ${match[1]} as a Contact`;
  match = value.match(/^组织“(.+)”已创建，可从组织详情或左下角切换。$/);
  if (match) return `Organization “${match[1]}” was created. Switch to it from Organization Details or the lower-left workspace menu.`;
  match = value.match(/^组织“(.+)”已创建，但工作空间列表刷新失败，请稍后重试。$/);
  if (match) return `Organization “${match[1]}” was created, but the workspace list could not be refreshed. Try again later.`;
  match = value.match(/^已加入并切换到组织“(.+)”(，已设为默认工作空间)?。$/);
  if (match) return `Joined and switched to organization “${match[1]}”${match[2] ? ' and set it as the default workspace' : ''}.`;
  match = value.match(/^已加入组织“(.+)”，但未能自动切换工作空间。$/);
  if (match) return `Joined organization “${match[1]}”, but could not switch to its workspace automatically.`;
  match = value.match(/^已招募\s*(\d+)\s*名\s*·\s*(可继续招募|当前额度已满)$/);
  if (match) return `${match[1]} hired · ${match[2] === '可继续招募' ? 'Can hire more' : 'Limit reached'}`;
  match = value.match(/^需先安装\s*(.+)，安装后才可招募$/);
  if (match) return `Install ${translateUiText(match[1], 'en')} before hiring`;
  match = value.match(/^剩余\s*(\d+)\s*名(?:\s*·\s*(\d+)\s*名确认中)?$/);
  if (match) return `${match[1]} remaining${match[2] ? ` · ${match[2]} pending confirmation` : ''}`;
  match = value.match(/^已超出当前额度\s*(\d+)\s*名，现有员工不受影响$/);
  if (match) return `${match[1]} over the current limit · existing Agents are unaffected`;
  match = value.match(/^员工额度\s*(\d+)\s*\/\s*(\d+)，(.+)$/);
  if (match) return `Agent capacity ${match[1]} / ${match[2]} · ${translateUiText(match[3], 'en')}`;
  match = value.match(/^(\d+)\s*个账号记录$/);
  if (match) return `${match[1]} account record${match[1] === '1' ? '' : 's'}`;
  match = value.match(/^今日额度\s*(\d+(?:\.\d+)?)%$/);
  if (match) return `Today’s Allowance ${match[1]}%`;
  match = value.match(/^今日 Token 额度\s*(\d+(?:\.\d+)?)%$/);
  if (match) return `Today’s Token Allowance ${match[1]}%`;
  match = value.match(/^今日\s+(.+?)\s*·\s*不限额$/);
  if (match) return `Today ${match[1]} · No Limit`;
  match = value.match(/^今日\s+(.+?)\s*\/\s*(.+)$/);
  if (match) return `Today ${match[1]} / ${match[2]}`;
  match = value.match(/^今日\s+(.+)$/);
  if (match) return `Today ${match[1]}`;
  match = value.match(/^剩余\s+([\d,.KMB]+)(\s+tokens?)?$/i);
  if (match) return `${match[1]}${match[2] || ''} remaining`;
  match = value.match(/^(.+?)\s+可用\s*·\s*北京时间\s*00:00\s*重置$/);
  if (match) return `${match[1]} Available · Resets at 00:00 Beijing Time`;
  match = value.match(/^(.+?)\s+可用\s*·\s*(.+?)\s*重置$/);
  if (match) return `${match[1]} Available · Resets ${match[2]}`;
  match = value.match(/^默认模型服务今日已使用\s+(.+?)(?:\s*\/\s*(.+?))?；剩余\s+(.+?)；北京时间\s*00:00\s*重置$/);
  if (match) return `Default model service used today: ${match[1]}${match[2] ? ` / ${match[2]}` : ''} · ${match[3]} remaining · Resets at 00:00 Beijing time`;
  match = value.match(/^默认模型服务今日已使用\s+(.+)$/);
  if (match) return `Default model service used today: ${match[1]}`;
  match = value.match(/^(.+?)\s*重置$/);
  if (match && /\d|下周|Next Week/i.test(match[1])) return `Resets ${translateUiText(match[1], 'en')}`;
  match = value.match(/^输入\s+(.+?)(?:（缓存命中\s+(.+?)）)?\s*·\s*输出\s+(.+)$/);
  if (match) return `Input ${match[1]}${match[2] ? ` (cached ${match[2]})` : ''} · Output ${match[3]}`;
  match = value.match(/^(\d+)\s*次\s*·\s*等价 Token$/);
  if (match) return `${match[1]} image${match[1] === '1' ? '' : 's'} · Token equivalent`;
  match = value.match(/^；最近一轮\s+(.+?)（输入\s+(.+?)\s*\/\s*输出\s+(.+?)）$/);
  if (match) return ` · Latest turn ${match[1]} (input ${match[2]} / output ${match[3]})`;
  match = value.match(/^(\d+)\s*个活跃\s*·\s*(\d+)\s*个归档$/);
  if (match) return `${match[1]} active · ${match[2]} archived`;
  match = value.match(/^所选：(.+?)\s*·\s*(只读归档|活跃上下文)\s*·\s*(\d+)\s*条消息$/);
  if (match) return `Selected: ${match[1]} · ${translateUiText(match[2], 'en')} · ${match[3]} message${match[3] === '1' ? '' : 's'}`;
  match = value.match(/^上下文边界：epoch\s*(\d+)(?:\s*·\s*最近压缩\s*(.+))?$/);
  if (match) return `Context boundary: epoch ${match[1]}${match[2] ? ` · Last compacted ${match[2]}` : ''}`;
  match = value.match(/^(.+)\s*的对话上下文$/);
  if (match) return `${match[1]} Conversation Context`;
  match = value.match(/^(\d+)\s*条消息\s*·\s*(\d+)\s*个文件\s*·\s*(.+)$/);
  if (match) return `${match[1]} message${match[1] === '1' ? '' : 's'} · ${match[2]} file${match[2] === '1' ? '' : 's'} · ${translateUiText(match[3], 'en')}`;
  match = value.match(/^下一等级\s+(.+)$/);
  if (match) return `Next Level ${match[1]}`;
  match = value.match(/^暂定原因：(.+)。$/);
  if (match) return `Provisional reason: ${translateUiText(match[1], 'en')}.`;
  match = value.match(/^统计窗口\s+(.+)\s+至\s+(.+)。$/);
  if (match) return `Assessment window: ${match[1]} to ${match[2]}.`;
  match = value.match(/^(暂定原因：(.+)。|当前表现等级已达到有效任务样本要求。)\s*统计窗口\s+(.+)\s+至\s+(.+)。$/);
  if (match) {
    const summary = match[2]
      ? `Provisional reason: ${translateUiText(match[2], 'en')}.`
      : 'The current performance level has enough valid task evidence.';
    return `${summary} Assessment window: ${match[3]} to ${match[4]}.`;
  }
  if (value.includes('、')) {
    const translatedItems = value.split('、').map((item) => ENGLISH_EXACT[item.trim()] || '').filter(Boolean);
    if (translatedItems.length === value.split('、').length) return translatedItems.join(', ');
  }
  match = value.match(/^有效任务\s+(\d+)$/);
  if (match) return `Valid tasks ${match[1]}`;
  match = value.match(/^(交付|拆解|返工|协调|提升|安全)\s+(\d+(?:\.\d+)?)$/);
  if (match) {
    const metric = { '交付': 'Delivery', '拆解': 'Decomposition', '返工': 'Rework', '协调': 'Coordination', '提升': 'Uplift', '安全': 'Safety' }[match[1]];
    return `${metric} ${match[2]}`;
  }
  match = value.match(/^最近\s*90\s*天有效领导任务\s*(\d+)\/100；下一等级\s*(.+)；状态\s*(.+)$/);
  if (match) return `Valid leadership tasks in the last 90 days: ${match[1]}/100 · Next level: ${match[2]} · Status: ${match[3]}`;
  match = value.match(/^我的 uBuddy 是专业私人秘书与任务协调入口，擅长(.+)，并遵守确认、隐私与真实状态边界。$/);
  if (match) return `My uBuddy is a professional private secretary and task-coordination hub, skilled in ${translateProfileSequence(match[1])}, while respecting confirmation, privacy, and truthful-status boundaries.`;
  match = value.match(/^当前有效 Skill 可验证地覆盖(.+)；同时规定(.+)，并要求保护私有信息、核验结果状态和避免未经确认的对外承诺。$/);
  if (match) return `Active Skills verifiably cover ${translateProfileSequence(match[1])}. They also define ${translateProfileSequence(match[2])}, protect private information, verify result status, and prevent unconfirmed external commitments.`;
  match = value.match(/^问题\s*(\d+)$/);
  if (match) return `Question ${match[1]}`;
  match = value.match(/^检测到\s*(\d+)\s*条旧消息，恢复前会备份当前数据库。$/);
  if (match) return `${match[1]} old messages were found. The current database will be backed up before recovery.`;
  match = value.match(/^当前数据库完整性：(.+)；检测到\s*(\d+)\s*个可恢复的隔离旧库。$/);
  if (match) return `Current database integrity: ${match[1]}; ${match[2]} recoverable quarantined databases found.`;
  match = value.match(/^检测到\s*(\d+)\s*项待迁移结构和\s*(\d+)\s*项一致性问题，可以安全自动修复。$/);
  if (match) return `${match[1]} pending migrations and ${match[2]} consistency issues were found and can be repaired safely.`;
  match = value.match(/^完整性：(.+)；待迁移：(\d+)；一致性异常：(\d+)。$/);
  if (match) return `Integrity: ${match[1]}; pending migrations: ${match[2]}; consistency issues: ${match[3]}.`;
  match = value.match(/^云端已确认\s*(\d+)\s*条，约\s*(\d+)\s*条仅存在本地。$/);
  if (match) return `Cloud coverage is confirmed for ${match[1]} messages; about ${match[2]} are local only.`;
  match = value.match(/^云端覆盖尚未确认，当前\s*(\d+)\s*条消息都必须按仅本地数据保护。$/);
  if (match) return `Cloud coverage is unknown. All ${match[1]} messages must be protected as local-only data.`;
  match = value.match(/^(.+) 私人助手\s*(\d+)\s*条，非个人 Workspace\s*(\d+)\s*条，附件\s*(\d+)\s*个，待上传文件\s*(\d+)\s*个。$/);
  if (match) return `${translateUiText(match[1], 'en')} Private-assistant messages: ${match[2]}; non-personal Workspace messages: ${match[3]}; attachments: ${match[4]}; pending uploads: ${match[5]}.`;
  match = value.match(/^(.+) · 完整性 (.+) · (\d+) 个会话 · (\d+) 条消息 · (\d+) 个 Memory$/);
  if (match) return `${match[1]} · Integrity: ${match[2]} · ${match[3]} conversations · ${match[4]} messages · ${match[5]} Memory documents`;
  match = value.match(/^(.+) · 完整性 (.+)$/);
  if (match) return `${match[1]} · Integrity: ${match[2]}`;
  match = value.match(/^默认页风格\s*(\d+)$/);
  if (match) return `Home style ${match[1]}`;
  match = value.match(/^修订\s*(\d+)$/);
  if (match) return `Revision ${match[1]}`;
  match = value.match(/^(\d+)\s*项$/);
  if (match) return `${match[1]} items`;
  match = value.match(/^(\d+)\s*天$/);
  if (match) return `${match[1]} days`;
  match = value.match(/^(\d+)\s*个$/);
  if (match) return `${match[1]}`;
  match = value.match(/^(\d+)\s*位$/);
  if (match) return `${match[1]}`;
  match = value.match(/^(\d+)\s*名$/);
  if (match) return `${match[1]}`;
  match = value.match(/^已授权公开给(.+)$/);
  if (match) return `Shared with ${translateUiText(match[1], 'en')}`;
  match = value.match(/^确认并(公开|启用)$/);
  if (match) return match[1] === '公开' ? 'Confirm & Share' : 'Confirm & Activate';
  match = value.match(/^生成时间：(.+)$/);
  if (match) return `Generated: ${match[1]}`;
  match = value.match(/^(.+) avatar$/);
  if (match) {
    const name = translateUiText(match[1], 'en');
    if (name !== match[1]) return `${name} avatar`;
  }
  match = value.match(/^(.+)的头像$/);
  if (match) return `${match[1]} avatar`;
  match = value.match(/^工作群\s+(.+)$/);
  if (match) return `Workgroup ${match[1]}`;
  match = value.match(/^第\s*(\d+)\s*页$/);
  if (match) return `Page ${match[1]}`;
  match = value.match(/^发现 Janus\s+(.+)$/);
  if (match) return `Janus ${match[1]} Is Available`;
  match = value.match(/^Janus\s+(.+)\s+已更新$/);
  if (match) return `Janus ${match[1]} Updated`;
  match = value.match(/^版本\s+(.+)$/);
  if (match) return `Version ${match[1]}`;
  match = value.match(/^正在下载更新(?:\s*·\s*(\d+)%)*$/);
  if (match) return `Downloading update${match[1] ? ` · ${match[1]}%` : ''}`;
  match = value.match(/^下载中(?:\s*(\d+)%)*$/);
  if (match) return `Downloading${match[1] ? ` ${match[1]}%` : ''}`;
  if (value.includes(' · ')) {
    const parts = value.split(' · ');
    const translatedParts = parts.map((part) => translateUiText(part, 'en'));
    if (translatedParts.some((part, index) => part !== parts[index])) return translatedParts.join(' · ');
  }
  if (value.includes('，')) {
    const separator = value.indexOf('，');
    const parts = [value.slice(0, separator), value.slice(separator + 1)];
    const translatedParts = parts.map((part) => translateUiText(part, 'en'));
    if (translatedParts.some((part, index) => part !== parts[index])) return translatedParts.join(', ');
  }
  match = value.match(/^(\d+)\s*位成员$/);
  if (match) return `${match[1]} members`;
  match = value.match(/^(\d+)\s*位联系人$/);
  if (match) return `${match[1]} contacts`;
  match = value.match(/^(\d+)\s*条未读消息$/);
  if (match) return `${match[1]} unread`;
  match = value.match(/^(\d+)\s*条消息$/);
  if (match) return `${match[1]} messages`;
  match = value.match(/^(\d+)\s*个群组$/);
  if (match) return `${match[1]} groups`;
  match = value.match(/^(\d+)\s*个会话$/);
  if (match) return `${match[1]} conversations`;
  match = value.match(/^已完成\s*(\d+)\s*\/\s*(\d+)\s*个节点$/);
  if (match) return `${match[1]} of ${match[2]} nodes completed`;
  match = value.match(/^来自\s+(.+)$/);
  if (match) return `From ${match[1]}`;
  match = value.match(/^回复\s+(.+)$/);
  if (match) return `Reply to ${match[1]}`;
  match = value.match(/^与\s*(.+)\s*的会话$/);
  if (match) return `Chat with ${translateUiText(match[1], 'en')}`;
  match = value.match(/^与\s*(.+)\s*对话$/);
  if (match) return `Chat with ${translateUiText(match[1], 'en')}`;
  match = value.match(/^前往 uBuddy，并 @(.+)$/);
  if (match) return `Open uBuddy and @${translateUiText(match[1], 'en')}`;
  match = value.match(/^查看(.+)的简介$/);
  if (match) return `View ${translateUiText(match[1], 'en')} Profile`;
  match = value.match(/^查看\s+(.+)\s+详情$/);
  if (match) return `View ${translateUiText(match[1], 'en')} Details`;
  match = value.match(/^(.+)\s+详情$/);
  if (match) return `${translateUiText(match[1], 'en')} Details`;
  match = value.match(/^当前版本：(.+?)\s*·\s*最近检查：(.+)$/);
  if (match) return `Current version: ${match[1]} · Last checked: ${match[2]}`;
  return '';
}

function englishDynamicText(value = '', fallback = '', format = (text) => text) {
  if (/[\u3400-\u9fff]/.test(String(value || ''))) return fallback;
  const translated = translateUiText(value, 'en');
  return /[\u3400-\u9fff]/.test(translated) ? fallback : format(translated);
}

function translateProviderStatusPattern(value) {
  let match = value.match(/^当前 Provider：(.+)$/);
  if (match) return `Current Provider: ${match[1]}`;
  match = value.match(/^模型：(.+?) · 认证变量：(.+?) · API 地址：(.+)$/);
  if (match) return `Model: ${match[1]} · Authentication variable: ${match[2]} · API endpoint: ${match[3]}`;
  match = value.match(/^网络、鉴权和模型 (.+) 路由检查通过。$/);
  if (match) return `Network access, authentication, and routing for model ${match[1]} passed.`;
  match = value.match(/^Provider 不提供模型 (.+)；当前继续使用默认模型服务。$/);
  if (match) return `The Provider does not offer model ${match[1]}. The custom Provider was not enabled; Janus will continue using the default model service.`;
  match = value.match(/^Provider 网络、鉴权和 Responses API 可用（HTTP (\d+)）。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider network connection, authentication, and Responses API check passed (HTTP ${match[1]}).${match[2] ? ' Janus will continue using the default model service.' : ''}`;
  match = value.match(/^Provider Responses API 拒绝 API Key（HTTP (\d+)）。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider Responses API rejected the API key (HTTP ${match[1]}).${providerFallbackCopy(match[2])}`;
  match = value.match(/^Provider \/models 可用，但 Responses API 返回 HTTP (\d+)。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider /models endpoint is available, but the Responses API returned HTTP ${match[1]}.${providerFallbackCopy(match[2])}`;
  match = value.match(/^Provider 拒绝 API Key（HTTP (\d+)）。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider rejected the API key (HTTP ${match[1]}).${providerFallbackCopy(match[2])}`;
  match = value.match(/^Provider 服务异常（HTTP (\d+)）。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider returned a server error (HTTP ${match[1]}).${providerFallbackCopy(match[2])}`;
  match = value.match(/^Provider 可连接，但 \/models 返回 HTTP (\d+)；请确认该服务支持 Responses API 和所选模型。( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider is reachable, but /models returned HTTP ${match[1]}. Confirm that the service supports the Responses API and the selected model.${providerFallbackCopy(match[2])}`;
  match = value.match(/^Provider TLS\/网络连接失败：(.+?)( 当前继续使用默认模型服务。)?$/);
  if (match) return `The Provider TLS or network connection failed: ${match[1].replace(/。$/, '')}.${providerFallbackCopy(match[2])}`;
  match = value.match(/^Codex(.*?) 可用，配置加载、鉴权和 Provider 网络检查通过(；Doctor 返回 warning，但关键检查均可用。|。)$/);
  if (match) return `The Janus model runtime${match[1]} is available. Configuration loading, authentication, and Provider network checks passed.${match[2].startsWith('；') ? ' Janus diagnostics reported a warning, but all critical checks are available.' : ''}`;
  match = value.match(/^当前使用默认模型服务；config\.toml 和 auth\.json (尚未通过测试|暂未配置)。$/);
  if (match) return match[1] === '尚未通过测试'
    ? 'Janus is using the default model service because config.toml and auth.json have not passed the connection test.'
    : 'Janus is using the default model service; config.toml and auth.json have not been configured.';
  match = value.match(/^(.+) 当前继续使用默认模型服务。$/);
  if (match) return `${translateUiText(match[1], 'en')} Janus will continue using the default model service.`;
  return '';
}

function providerFallbackCopy(hasFallback) {
  return hasFallback ? ' The custom Provider was not enabled; Janus will continue using the default model service.' : '';
}

function translateProfileSequence(value = '') {
  const items = String(value || '')
    .replaceAll('以及', '、')
    .replaceAll('和', '、')
    .split('、')
    .map((item) => translateUiText(item.trim(), 'en'))
    .filter(Boolean);
  if (items.length < 2) return items[0] || '';
  return items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function localizeDom(root, language = 'en') {
  const normalized = normalizeLanguage(language);
  document.documentElement.lang = normalized;
  document.documentElement.dataset.language = normalized;
  if (!root) return;
  root.querySelectorAll('.lang-en, .lang-zh').forEach((element) => {
    element.classList.toggle('lang-en', normalized === 'en');
    element.classList.toggle('lang-zh', normalized !== 'en');
  });
  if (normalized !== 'en') return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const parent = node.parentElement;
    if (!parent || (parent.closest(SKIP_LOCALIZATION_SELECTOR) && !parent.closest('[data-localize-ui]'))) continue;
    const compactComposerLabel = parent.closest('.composer-context') && node.nodeValue.trim() === '私人助理';
    node.nodeValue = compactComposerLabel
      ? node.nodeValue.replace('私人助理', 'Private')
      : translateUiText(node.nodeValue, normalized);
  }
  for (const element of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
    const blocked = element.closest(SKIP_LOCALIZATION_SELECTOR);
    if (blocked && blocked !== element && !element.closest('[data-localize-ui]')) continue;
    if (element.matches('[data-no-localize]')) continue;
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      if (!element.hasAttribute(attribute)) continue;
      element.setAttribute(attribute, translateUiText(element.getAttribute(attribute), normalized));
    }
  }
}
