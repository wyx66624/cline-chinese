
# 更新日志

## [3.8.4]
    1. Cline Chinese特色功能：新增Dify Provider，感谢@lofyer，代码来自：https://github.com/lofyer/cline-dify/tree/main
    2. 合入cline 3.8新增特性和问题修复：
        关键特性：
        1. 添加到 Cline：在任何文件或终端中右键单击选定的文本，以快速将上下文添加到您当前的任务中！此外，当您看到灯泡图标时，选择“使用Cline 修复”让 Cline 修复您代码中的错误。
        2. 更快的推理：Cline/OpenRouter用户可以按吞吐量、价格和延迟对使用的底层提供商进行排序。按吞吐量排序将输出更快的生成结果（成本更高）。
        3. 增强的 MCP 支持：支持 GIF 的动态图像加载，以及一个新的删除按钮来清理失败的服务器。
        4. 近期新增模型支持，如gemini 2.5 pro, Deepseek-V3-0324，claude 3.7 sonnet-thinking.

## [3.4.12]
  - 修复如“xxx缺失必需参数”的报错。

## [3.4.10]
    - 合入cline 3.3.2-3.4.10版本修改，并进行汉化。
    - 已知问题修复。
    cline 更新内容：
    ## [3.4.10]
    -   添加对 GPT-4.5 预览版模型的支持

    ## [3.4.9]

    -   添加开关让用户选择是否加入匿名遥测和错误报告

    ## [3.4.6]

    -   添加对 Claude 3.7 Sonnet 的支持

    ## [3.4.0]

    -   引入 MCP 市场！现在你可以直接在扩展中发现和安装最佳的 MCP 服务器，并且会定期添加新的服务器。通过 MCP Servers 标签页即可开始使用！
    -   在计划模式中添加 mermaid 图表支持！现在 Cline 可以使用流程图、序列图、实体关系图等方式来可视化他的计划。当他使用 mermaid 解释他的方法时，你会在聊天中看到一个可点击展开的图表。
    -   使用 @terminal 来引用终端内容，使用 @git 来引用工作更改和提交！
    -   在编辑文件和运行命令后使用更多可视化的检查点指示器，并在每个任务开始时自动创建检查点。
    -   添加"终端"上下文提及功能，用于引用活动终端的内容
    -   添加"Git 提交"上下文提及功能，用于引用当前工作更改或特定提交（感谢 @mrubens！）
    -   在切换计划/执行模式或点击"批准"按钮时，发送当前文本框内容作为额外反馈
    -   为 OpenAI 兼容添加高级配置选项（上下文窗口、最大输出、定价等）
    -   添加阿里巴巴 Qwen 2.5 编码模型、VL 模型和 DeepSeek-R1/V3 支持
    -   改进对 AWS Bedrock Profiles 的支持
    -   修复 Mistral 提供商对非 codestral 模型的支持
    -   添加禁用浏览器工具的高级设置
    -   添加设置 chromium 可执行路径的高级设置

    在这里查看更新演示！加入我们的 X、Discord 或 r/cline 社区获取更多更新！

## [3.3.2]
    合入cline 3.30-3.3.2版本修改，并进行汉化。
    修复了一些汉化问题
    
    cline更新内容：
    ## [3.3.2]
    -   修复 OpenRouter 请求偶尔不返回成本/令牌统计信息的问题，这会导致上下文窗口限制错误
    -   使检查点更加可见并跟踪已恢复的检查点

    ## [3.3.0]

    -   添加 .clineignore 功能以阻止 Cline 访问指定的文件模式
    -   为计划/执行切换添加键盘快捷键和工具提示
    -   修复新文件不会在文件下拉列表中显示的问题
    -   为限速请求添加自动重试功能（感谢 @ViezeVingertjes！）
    -   在高级设置中添加 o3-mini 的推理努力度支持
    -   添加使用 AWS CLI 创建配置文件的 AWS 提供商配置文件支持，实现与 AWS bedrock 的长期连接
    -   添加 Requesty API 提供商
    -   添加 Together API 提供商
    -   添加阿里巴巴 Qwen API 提供商（感谢 @aicccode！）

## [3.2.13]

- 基于cline 3.2.13 初始化项目
- 汉化 Cline 的 UI 界面
- 汉化 Cline 的 提示词
- 汉化 Cline 的 快捷键
- 汉化 Cline 的 设置
- 汉化 Cline 的 命令
- 汉化 Cline 的 配置
- 汉化 Cline 的 日志



# Changelog

## [3.8.4]

-   Add Sambanova Deepseek-V3-0324
-   Add cost calculation support for LiteLLM provider
-   Fix bug where Cline would use plan_mode_response bug without response parameter

## [3.8.3]

-   Add support for SambaNova QwQ-32B model
-   Add OpenAI "dynamic" model chatgpt-4o-latest
-   Add Amazon Nova models to AWS Bedrock
-   Improve file handling for NextJS folder naming (fixes issues with parentheses in folder names)
-   Add Gemini 2.5 Pro to Google AI Studio available models
-   Handle "input too large" errors for Anthropic
-   Fix "See more" not showing up for tasks after task un-fold
-   Fix gpt-4.5-preview's supportsPromptCache value to true

## [3.8.2]

-   Fix bug where switching to plan/act would result in VS Code LM/OpenRouter model being reset

## [3.8.0]

-   Add 'Add to Cline' as an option when you right-click in a file or the terminal, making it easier to add context to your current task
-   Add 'Fix with Cline' code action - when you see a lightbulb icon in your editor, you can now select 'Fix with Cline' to send the code and associated errors for Cline to fix. (Cursor users can also use the 'Quick Fix (CMD + .)' menu to see this option)
-   Add Account view to display billing and usage history for Cline account users. You can now keep track of credits used and transaction history right in the extension!
-   Add 'Sort underling provider routing' setting to Cline/OpenRouter allowing you to sort provider used by throughput, price, latency, or the default (combination of price and uptime)
-   Improve rich MCP display with dynamic image loading and support for GIFs
-   Add 'Documentation' menu item to easily access Cline's docs
-   Add OpenRouter's new usage_details feature for more reliable cost reporting
-   Display total space Cline takes on disk next to 'Delete all Tasks' button in History view
-   Fix 'Context Window Exceeded' error for OpenRouter/Cline Accounts (additional support coming soon)
-   Fix bug where OpenRouter model ID would be set to invalid value
-   Add button to delete MCP servers in a failure state

