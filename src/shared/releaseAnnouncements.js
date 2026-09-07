export const RELEASE_ANNOUNCEMENTS = Object.freeze([
  Object.freeze({
    version: '1.1.0',
    date: '2026-08-16',
    title: 'Follower Beta 与全新协作体验',
    summary: '推出 Follower Beta，重置 uBuddy 的界面与功能协作链路，并集中改进 PPT 交付、桌面后台运行以及多项日常功能与界面体验。',
    highlights: Object.freeze([
      '推出 Follower Beta，可按需或定时整理任务、对话与项目变化，生成每日简报、每周回顾和成长建议。',
      '重置 uBuddy 的界面与功能耦合，任务规划、执行、进度、澄清与交付状态衔接更加清晰稳定。',
      '修复 PPT 员工从内容生成、配图、渲染预览到文件交付中的多处问题，并增强失败恢复能力。',
      '新增客制化桌面关闭行为，可选择关闭窗口后继续后台运行，或直接退出 Janus。',
      '优化消息、任务、联系人、文件预览、通知导航和中英文界面，并修复多项功能与 UI Bug。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: 'Follower Beta',
        items: Object.freeze([
          '新增 Follower 跟进助手 Beta，从有权访问的 Agent 任务、对话和项目变化中整理值得关注的工作进展。',
          '支持立即生成或按本地时间定时生成每日简报、每周回顾和成长建议，并集中查看历史报告与未读提醒。',
          '报告中的事实与建议可回看对应来源；Follower 只读访问当前可见内容，不会修改原始任务、消息或文件。',
          '支持围绕报告继续追问、提交有用性反馈，并在已连接云服务时同步报告与偏好演进状态。',
        ]),
      }),
      Object.freeze({
        title: 'uBuddy 重置与协作体验',
        items: Object.freeze([
          '重置 uBuddy 的界面状态与任务功能耦合，减少切换会话、刷新页面或任务状态变化时的错位、残留和重复反馈。',
          '统一任务接收、澄清、规划、员工分配、执行、质量检查和最终交付的状态表达，复杂协作更容易跟踪。',
          '完善任务草稿、私有工作区、来源消息定位、进度更新和失败恢复，降低长任务或网络波动造成的上下文丢失。',
          '优化联系人、工作群和跨用户委托中的 uBuddy 入口、协作状态与交付验收体验。',
        ]),
      }),
      Object.freeze({
        title: 'PPT 员工与文件交付',
        items: Object.freeze([
          '修复 PPT 员工在内容解析、版式生成、配图、渲染和预览阶段的多项失败与兼容性问题。',
          '图片生成与 PPT 制作共享统一的 Provider 和额度状态，配图失败时可保留可用内容并给出更准确的结果。',
          '增加简化版式重试、渲染进度与错误诊断，提升复杂内容和不同桌面环境下的成稿成功率。',
          '完善 PPTX 及其他 Office 文件的识别、预览、打开和协作交付，减少无效文件或交付状态不一致。',
        ]),
      }),
      Object.freeze({
        title: '客制化桌面体验',
        items: Object.freeze([
          '首次关闭最后一个窗口时，可选择让 Janus 继续后台运行或直接退出，并可记住选择。',
          '在设置中可随时切换关闭行为；后台运行时，本机任务继续处理，并可从 macOS Dock 或菜单栏重新打开 Janus。',
          '完善桌面通知后的页面定位、单实例唤醒和窗口恢复，让后台任务完成后的返回路径更顺畅。',
        ]),
      }),
      Object.freeze({
        title: '其他功能、界面与稳定性修复',
        items: Object.freeze([
          '优化消息列表、输入草稿、会话切换、任务详情、联系人与工作群中的多项交互和显示细节。',
          '改进文件预览、附件处理、通知导航、设置状态与云端同步在异常或网络波动时的可靠性。',
          '同步完善中英文界面，并修复深色模式、布局、状态提示和局部内容闪现等 UI Bug。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.3.0',
    date: '2026-08-07',
    title: '从任务协作到成果验收的完整升级',
    summary: '集中升级消息与任务界面、跨用户委托交付、Office 文件预览、员工云端衔接和模型服务配置，让复杂工作更容易跟踪、交付和验收。',
    highlights: Object.freeze([
      '消息页、深色主题、聊天搜索、快捷键、文字缩放和输入体验完成一轮系统优化。',
      'uBuddy 新增会话任务状态条，可筛选进度、查看恢复状态、定位来源消息并及时发现新进展。',
      '跨用户委托支持接收方交付、发出方验收或打回重做，并保留全部交付版本和任务群状态。',
      'DOCX、XLSX、PPTX、图片和普通文档的格式识别、预览转换与文件操作更加可靠。',
      '已有本地员工可保留身份和启用状态接入云端，组织敏感操作也可在当前登录期间记住二次验证。',
      '正式包提供内置模型服务作为默认回退；本机 Provider 只有保存并测试通过后才会启用。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: '消息、界面与任务跟踪',
        items: Object.freeze([
          '聊天搜索入口移到消息页标题区，支持 Ctrl/⌘ + F 根据当前页面搜索聊天、联系人或内容。',
          '支持会话文字缩放和快捷键提示，并修复输入法组合态、快速切换会话和消息刷新中的多处边界问题。',
          '完善深色主题以及聊天、设置、插件、员工、附件、协作和任务详情页面的布局与表面颜色。',
          'uBuddy 会话新增任务状态条，可筛选进行中、需处理、重试中和已完成任务，跳回来源消息并提示新进展。',
          '任务详情展示最近进展、创建/更新时间、恢复尝试、自动重试和需要用户处理的具体状态。',
        ]),
      }),
      Object.freeze({
        title: '协作委托与交付验收',
        items: Object.freeze([
          '多人分工方案生成失败时保留成员与任务要求，可以重新生成或取消，不会派发不完整任务。',
          '跨用户委托由接收方确认交付，再由发出方验收结束或打回重做，双方看到一致的阶段状态。',
          '任务群同步发布要求、提交结果、修改意见和验收结果，并保留所有历史交付版本供回看。',
          '委托附件在任务和交付完成前保持可用；本机副本缺失时可从共享工作区恢复并校验内容。',
          '旧消息只建立自动化基线，不会因重新登录、编辑时间变化或历史补拉而重复触发任务。',
        ]),
      }),
      Object.freeze({
        title: '文件、Office 与成果处理',
        items: Object.freeze([
          '增强 DOCX、XLSX、PPTX 和旧版 Office 文件的真实格式识别，减少扩展名正确但内容无效的假交付。',
          'Office 文件可转换为安全预览，图片、PPT、文档和附件卡片的打开、预览、定位与下载操作统一。',
          '修复文件按钮重复监听导致的一次点击多次执行，并完善大文件、协作文件与交付物的生命周期管理。',
          'PPT 员工目录和本机 Skill 状态完成一致性修复，避免云端目录把未安装能力误显示为可执行。',
        ]),
      }),
      Object.freeze({
        title: '员工、组织与模型服务',
        items: Object.freeze([
          '绑定云账号后，已有本地员工可保留实例 ID、名称、序号和启用/停用状态接入云端。',
          '组织敏感操作可在当前登录期间记住二次验证，授权过期、账号变化或退出登录后自动清除。',
          '私人助理额度补充最近一轮输入、输出、缓存命中和图片折算说明，使用量计算更透明。',
          '内置模型服务作为默认回退；自定义 Provider 只有保存并测试通过后启用，配置变化后需要重新验证。',
        ]),
      }),
      Object.freeze({
        title: '文档与部署',
        items: Object.freeze([
          '新增中英文项目首页和自托管指南，整理桌面端、云端 API、数据库、邮件、HTTPS 和 Evolution Worker 的部署边界。',
          '改进三平台发布的一致性校验，确保安装包来自同一份已验证源码。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.28',
    date: '2026-08-06',
    title: '任务理解、模型适配与社交交互升级',
    summary: '让日常界面和联系人交互更顺手，同时增强 uBuddy 在长上下文与慢 Provider 下的任务理解恢复，并确保模型选择始终匹配当前 Provider。',
    highlights: Object.freeze([
      '完成多处 UI 优化，覆盖聊天消息、设置页、更新公告、任务详情、Janus 变更审阅、上下文用量和导航细节。',
      '点击私聊或群聊中对方的头像即可查看简介；群聊简介卡片还可以直接发起私聊。',
      'uBuddy 面对长对话、附件和项目资料时会更耐心，并在等待过久后自动精简上下文重试。',
      '模型目录只展示当前 Provider 实际可用的模型，失效模型和不支持的 Reasoning 会自动回退。',
      '模型响应超时与本机运行组件缺失会分别提示；领取 Provider Key 后也会立即刷新模型选项。',
      '延续 0.2.27 的后台隔离权限、失败自恢复、统一 Agent 执行和开放 Provider 配置改进。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: '界面与联系人交互',
        items: Object.freeze([
          '统一聊天消息、头像、设置页、更新公告、任务详情、Janus 变更审阅、上下文用量和导航的多处视觉与交互细节。',
          '私聊和群聊中的对方头像支持点击，简介卡片展示昵称、唯一账号、机构和个人介绍。',
          '从群聊打开简介时可以直接发起私聊；自己的头像和连续消息占位不会错误触发简介弹层。',
          '更新前简要公告最多展示 6 条重点，标题、摘要和第一条要点不再重复表达同一内容。',
        ]),
      }),
      Object.freeze({
        title: 'uBuddy 任务理解与超时恢复',
        items: Object.freeze([
          '复杂任务请求获得更充足的理解时间，长对话、附件和项目资料不再轻易导致任务创建中断。',
          '等待过久时会自动精简最近消息、附件文本和项目/Memory 引用后再次尝试。',
          '再次等待仍未完成时，会结合明确的工作动作、@成员、附件、已有任务信息、隐私范围和风险级别安全续接。',
          '模型响应超时与本机运行组件缺失会分别提示，不再把网络或 Provider 较慢误报成本机组件缺失。',
        ]),
      }),
      Object.freeze({
        title: '模型与 Provider 适配',
        items: Object.freeze([
          '模型目录只展示当前 Provider 实际可用的模型，已经下线的旧模型不会继续出现。',
          '历史任务或配置引用失效模型时，会回退到当前有效默认模型。',
          '当旧 Reasoning 等级不被目标模型支持时，自动切换到可用等级，避免重复失败。',
          '模型连接诊断更完整；Provider Key 领取后立即刷新模型目录及其 Reasoning 能力。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.27',
    date: '2026-08-06',
    title: 'uBuddy 自恢复、统一执行与开放 Provider 配置',
    summary: '这是 0.2.21 之后的累计升级：完善 uBuddy 后台执行与失败恢复，修复新任务和消息刷新问题，并将正式包切换为不内置公司凭据的开放配置版本。',
    highlights: Object.freeze([
      '后台任务固定使用仅可写任务 Workspace 的隔离权限，不再继承需要实时批准的聊天权限。',
      '任务节点接入统一 Agent 工作执行链路，普通失败会先唤醒 uBuddy 进行有限自动恢复。',
      '修复新建文件请求返回旧任务结果，以及异步消息刷新覆盖新内容的问题。',
      '开放配置正式包不内置公司 Provider Key；账号可提交申请并在管理员批准后于应用内领取。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: 'uBuddy 后台执行与恢复',
        items: Object.freeze([
          '单人和多人 uBuddy 任务统一采用 task-workspace 权限，只允许在所选项目或隔离任务目录内写入。',
          '保留用户原始权限选择用于审计，但后台不再依赖无法响应的实时批准回调。',
          '新增 recovery_required wake，uBuddy 可根据失败报告应用 fallback、修正权限并有限重试。',
          '恢复状态和尝试次数持久化，应用重启后可以安全续跑且不会重复执行同一 wake。',
          '缺少输入、凭据、真实目录权限或系统沙箱不可用时，由 uBuddy 确认后再提示用户。',
          '任务节点接入统一 Agent 工作执行内核，复用标准会话、工具事件、消息保存和交付物链路。',
        ]),
      }),
      Object.freeze({
        title: '任务与消息稳定性',
        items: Object.freeze([
          '外部委托的补充回答会继续原任务，不再误入候选用户校验。',
          '明确包含创建、编写、修改、构建等动作的请求优先作为新工作处理，末尾要求返回路径不会再触发旧任务查询。',
          '消息列表使用按会话递增的请求版本保护，较早返回的异步请求不会覆盖新消息或当前会话。',
          '改进 Janus 变更审阅、上下文设置、运行时配置和任务切换，减少重复刷新与跨会话状态污染。',
        ]),
      }),
      Object.freeze({
        title: 'Provider 与发行安全',
        items: Object.freeze([
          'Windows、Linux 和 macOS 正式包默认采用开放配置发行模式，不从构建环境内置公司 Provider 凭据。',
          '已验证邮箱的账号可提交 Provider Key 申请；云端管理员可在应用内审核，批准结果通过邮件通知。',
          '获批用户在应用内领取 Provider 配置并写入本机 config.toml 与 auth.json，真实 Key 不通过邮件发送。',
          '保留显式启用的内部嵌入兼容模式，并增加官方端点、凭据形态和打包内容校验。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.26',
    date: '2026-08-06',
    title: 'uBuddy 协作交付、身份隔离与桌面体验升级',
    summary: '汇总 0.2.21 之后的协作任务、账号空间、社交消息、交付物和跨平台发布改进，为 0.2.27 的统一执行与自恢复打下基础。',
    highlights: Object.freeze([
      '单人和多人 uBuddy 任务统一采用 bounded review，由任务所有者的 uBuddy 验收并保留交付版本。',
      '账号、组织、Workspace、Agent 家族和实例身份进一步隔离，历史会话与任务升级更可靠。',
      '好友、私聊、群聊、协作文件和任务状态同步完成一轮完整稳定性升级。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: 'uBuddy 与交付',
        items: Object.freeze([
          '增强多成员任务规划、明确 @ 用户分工、能力 Profile、Agent 工作状态投影、任务引用和私有委托工作区。',
          '修复节点已返回诊断却显示完成、验收失败进度回退、委托终态与进度不同步等问题。',
          '完善 PPT、Word、Excel、图片和 Markdown 交付；普通文档不再被擅自强制转换成 DOCX。',
        ]),
      }),
      Object.freeze({
        title: '账号、消息与工作空间',
        items: Object.freeze([
          '统一 Agent 家族和实例身份，修复重复主会话、历史窗口、Owner 转移及跨空间上下文问题。',
          '完善好友、私聊、群聊和任务群的消息分页、撤回/改写、文件缓存、断点传输、联系人显示名和会话摘要同步。',
          '优化启动、桌面活动、休眠恢复、导航、目标/计划模式、执行过程、上下文用量和任务详情展示。',
        ]),
      }),
      Object.freeze({
        title: '升级与发布可靠性',
        items: Object.freeze([
          '加强数据库迁移、历史升级、云同步协议、恢复隔离和诊断校验，保护既有会话、消息、任务和文件。',
          'Windows、Linux 和 macOS 打包流程增加来源提交、更新签名、平台内容验证和跨平台自动化测试。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.21',
    date: '2026-08-02',
    title: 'uBuddy 调度、协作文件与工作空间稳定性升级',
    summary: '重构 uBuddy 的决策、规划和员工分配链路，补齐群聊与协作文件的可靠传输和离线缓存，并集中修复工作空间、上下文与交付物验收问题。',
    highlights: Object.freeze([
      'uBuddy 可在一次模型决策中直接回答、请求澄清或形成正式任务图，并持久化后台规划进度。',
      '忙碌员工支持排队等待和空闲后自动分配，多 Agent 任务由 leader 统一协调与最终交付。',
      '群聊、私聊和协作任务附件支持完整性校验、离线缓存，以及最高 2 GB 的断点续传。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: 'uBuddy 与 Agent 协作',
        items: Object.freeze([
          '统一 uBuddy 回合决策：根据目标选择直接回答、补充澄清或创建可执行任务图，不再依赖旧规则静默降级。',
          '任务规划改为可恢复的后台作业，应用重启或短暂失败后可继续处理，并保留清晰的规划、等待和失败状态。',
          '新增员工可用性、原子预留和持久化等待队列；指定员工忙碌时，任务会等待其空闲后自动开始。',
          '多 Agent 任务按领导力、职级、表现和任务相关度选择 leader，并确保最终结果由 leader 汇总交付。',
          '交付物契约支持多个阶段产物、真实文件格式校验和 PPT 精确页数验收，减少把过程记录误当成最终成果。',
        ]),
      }),
      Object.freeze({
        title: '文件与消息协作',
        items: Object.freeze([
          '群聊消息可发送和下载附件，私聊、群聊、协作群与协作任务使用统一的文件描述和权限校验。',
          '60 MB 以内文件走快速上传；更大文件使用 16 MB 分片断点续传，单文件最高支持 2 GB。',
          '上传和下载校验文件大小、分片哈希及完整 SHA-256，冲突或内容变化会明确失败，不发布不完整文件。',
          '远程附件首次下载后保存到用户隔离的本地缓存，离线时仍可预览已缓存文件。',
          '完善 Word、Excel、PPT、PDF、图片和常见文本附件的提交、预览与交付识别。',
        ]),
      }),
      Object.freeze({
        title: '工作空间与稳定性',
        items: Object.freeze([
          '从任务工作区返回原会话时重新拉取消息和上下文状态，避免显示旧快照或错误的 Token 用量。',
          '上下文百分比仅在获得本次真实测量时展示，并按模型有效上下文窗口计算剩余空间。',
          '修复项目工作空间移除、Agent 会话隔离、消息引用、附件提交和多窗口状态同步中的多处边界问题。',
          '数据库升级新增 uBuddy 预留、等待和后台规划结构；迁移保留现有会话、消息、Memory、附件、任务与执行记录。',
          '云端新增群聊文件和大文件元数据表，旧文件接口与既有消息数据保持兼容。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.20',
    date: '2026-08-02',
    title: '消息、组织与更新体验进一步统一',
    summary: '集中统一桌面端的消息交互、工作空间导航、组织设置和更新体验，并补充可持续维护的版本公告体系。',
    highlights: Object.freeze([
      '新增更新公告弹窗、详细更新日志和“仅在更新中心提示”选项。',
      '工作空间切换、组织联系人、uBuddy 协作入口和人才市场布局更加一致。',
      '消息列表、群聊输入框、执行过程、右键菜单和消息快捷操作完成一轮统一。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: '功能优化',
        items: Object.freeze([
          '检测到新版本时展示简明公告，可直接下载或安装，并可跳转查看完整日志。',
          '更新完成后展示当前版本公告；用户可以关闭自动弹窗，但仍可从更新中心和帮助菜单查看。',
          '组织内联系人包含当前账号，“用uBuddy开始协作”可正确进入消息界面。',
          '单条命令直接展示执行内容，多条命令才使用折叠分组。',
        ]),
      }),
      Object.freeze({
        title: '界面优化',
        items: Object.freeze([
          '工作空间切换器在标题栏居中，消息列表改为更轻量的通栏布局。',
          '群聊详情和组织设置提高字号、强化区域标题层级并完善滚动。',
          '人才市场支持两个单成员分类并排，同分类保持每行最多两个 Agent。',
          '消息右下角提供复制和更多操作，右键菜单图标更清晰、说明更简洁。',
          '默认组织选择器和头像裁剪统一适配明暗主题与圆形头像。',
        ]),
      }),
      Object.freeze({
        title: '稳定性与兼容性',
        items: Object.freeze([
          '群聊输入框固定在底部，不再随消息增长发生位置漂移。',
          '更新公告和更新入口复用 Windows、macOS、Linux 的现有安全更新链路。',
          '会话悬停预览限制长度，降低长消息造成的界面遮挡。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.19',
    date: '2026-08-01',
    title: '工作空间与组织协作重构',
    summary: '引入账号工作空间模型，让不同组织拥有独立的消息与协作上下文，同时加强组织邀请、成员管理和历史数据修复。',
    highlights: Object.freeze([
      '不同组织可像不同工作空间一样切换，消息、通讯录和任务按空间隔离。',
      '补齐组织分享链接、邀请码管理、成员移出、退出和顺位继承流程。',
      '增强历史数据库快速修复，处理会话、任务群和工作空间的一致性问题。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: '功能优化',
        items: Object.freeze([
          '组织切换升级为工作空间切换，无需重新登录即可进入不同组织上下文。',
          '组织分享链接支持生成、查看、复制和重新生成，并展示组织号与创建者信息。',
          '邀请码支持修改及通过邮箱验证重置。',
          '联系人和员工支持星标；同类 Agent 多实例会话可分别显示和管理。',
          '自己与自己的聊天按普通联系人处理，并使用账号自设显示名。',
        ]),
      }),
      Object.freeze({
        title: '界面优化',
        items: Object.freeze([
          '组织标题区重新布局分享与切换入口，并优化分享链接弹窗。',
          '聊天消息增加头像，己方消息居右、其他消息居左。',
          '通讯录补齐分享链接加入组织和工作空间说明入口。',
        ]),
      }),
      Object.freeze({
        title: '稳定性',
        items: Object.freeze([
          '修复工作群重复会话和跨工作空间错误显示。',
          '快速修复机制覆盖会话唯一约束、群聊映射和 Memory 工作空间一致性。',
          '补齐多个组织管理接口缺失导致的“接口不存在”问题。',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    version: '0.2.18',
    date: '2026-07-31',
    title: 'PPT、文件预览与消息交互增强',
    summary: '重点完善 PPT 生成渲染、文件预览、消息交互和目标/计划模式，为后续工作空间重构打下基础。',
    highlights: Object.freeze([
      'PPT 生成链路补齐图片插入、模板选择、预览和生成后自检。',
      '增强 Word、Excel、图片等附件的预览与直接展示能力。',
      '消息支持引用、转发、撤回及更丰富的右键操作。',
    ]),
    sections: Object.freeze([
      Object.freeze({
        title: '功能优化',
        items: Object.freeze([
          'PPT Agent 按风格拆分 Skill，并修复 Windows 工具链、模板读取和预览兼容问题。',
          '恢复 PPT 图片生成、文档图片提取、最少配图和排版复查机制。',
          '增加 Word、Excel 和图片附件预览与消息内直接展示。',
          '消息支持复制、全选、引用、转发和自然人聊天撤回。',
          '补齐目标模式、计划模式的前端入口和后端调用。',
        ]),
      }),
      Object.freeze({
        title: '界面优化',
        items: Object.freeze([
          '消息默认页、Agent 状态和窄窗口聊天布局完成重构。',
          '通讯录联系人、员工卡片、详情抽屉和 Memory 页面完成多轮统一。',
          '私人助理权限、上下文管理和 Token 用量展示更加清晰。',
        ]),
      }),
      Object.freeze({
        title: '稳定性',
        items: Object.freeze([
          '修复 PPT 任务停留在页面结构阶段、预览失败和模板串用。',
          '完善 Windows 测试打包、安装进程清理和安装进度体验。',
        ]),
      }),
    ]),
  }),
]);

export function normalizeReleaseVersion(value = '') {
  return String(value || '').trim().replace(/^v/i, '').split(/[+-]/, 1)[0];
}

export function compareReleaseVersions(left = '', right = '') {
  const a = normalizeReleaseVersion(left).split('.').map((part) => Number(part) || 0);
  const b = normalizeReleaseVersion(right).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) === (b[index] || 0)) continue;
    return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

export function releaseAnnouncementForVersion(version = '') {
  const normalized = normalizeReleaseVersion(version);
  return RELEASE_ANNOUNCEMENTS.find((item) => normalizeReleaseVersion(item.version) === normalized) || null;
}

export function releaseAnnouncementsThrough(version = '') {
  const normalized = normalizeReleaseVersion(version);
  if (!normalized) return [...RELEASE_ANNOUNCEMENTS];
  return RELEASE_ANNOUNCEMENTS.filter((item) => compareReleaseVersions(item.version, normalized) <= 0);
}
