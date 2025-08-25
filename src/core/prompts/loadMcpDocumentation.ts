import { McpHub } from "@services/mcp/McpHub"

export async function loadMcpDocumentation(mcpHub: McpHub) {
	return `## 创建 MCP 服务器

创建 MCP 服务器时，重要的是要理解它们在非交互环境中运行。服务器无法启动 OAuth 流程、打开浏览器窗口或在运行时提示用户输入。所有凭据和身份验证令牌必须通过 MCP 设置配置中的环境变量预先提供。例如，Spotify 的 API 使用 OAuth 获取用户的刷新令牌，但 MCP 服务器无法启动此流程。虽然您可以指导用户获取应用程序客户端 ID 和密钥，但您可能必须创建一个单独的一次性设置脚本（如 get-refresh-token.js），该脚本捕获并记录拼图的最后一部分：用户的刷新令牌（即您可能使用 execute_command 运行脚本，这将打开浏览器进行身份验证，然后记录刷新令牌，以便您可以在命令输出中看到它，以便在 MCP 设置配置中使用）。

除非用户另有指定，否则新的 MCP 服务器应创建在：${await mcpHub.getMcpServersPath()}

### MCP 服务器示例

例如，如果用户想要给您检索天气信息的能力，您可以创建一个使用 OpenWeather API 获取天气信息的 MCP 服务器，将其添加到 MCP 设置配置文件，然后注意到您现在可以访问系统提示中的新工具和资源，您可以使用这些工具和资源向用户展示您的新功能。

以下示例演示了如何构建提供天气数据功能的 MCP 服务器。虽然此示例显示了如何实现资源、资源模板和工具，但在实践中，您应该更喜欢使用工具，因为它们更灵活并且可以处理动态参数。资源和资源模板实现主要包含在这里，用于演示不同 MCP 功能的目的，但真正的天气服务器可能只暴露用于获取天气数据的工具。（以下步骤适用于 macOS）

1. 使用 \`create-typescript-server\` 工具在默认 MCP 服务器目录中引导新项目：

\`\`\`bash
cd ${await mcpHub.getMcpServersPath()}
npx @modelcontextprotocol/create-server weather-server
cd weather-server
# 安装依赖
npm install axios
\`\`\`

这将创建一个具有以下结构的新项目：

\`\`\`
weather-server/
  ├── package.json
      {
        ...
        "type": "module", // 默认添加，使用 ES 模块语法 (import/export) 而不是 CommonJS (require/module.exports) (如果您在此服务器存储库中创建其他脚本（如 get-refresh-token.js 脚本），了解这一点很重要)
        "scripts": {
          "build": "tsc && node -e \"require('fs').chmodSync('build/index.js', '755')\"",
          ...
        }
        ...
      }
  ├── tsconfig.json
  └── src/
      └── weather-server/
          └── index.ts      # 主服务器实现
\`\`\`

2. 用以下内容替换 \`src/index.ts\`：

\`\`\`typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const API_KEY = process.env.OPENWEATHER_API_KEY; // 由 MCP 配置提供
if (!API_KEY) {
  throw new Error('OPENWEATHER_API_KEY 环境变量是必需的');
}

interface OpenWeatherResponse {
  main: {
    temp: number;
    humidity: number;
  };
  weather: [{ description: string }];
  wind: { speed: number };
  dt_txt?: string;
}

const isValidForecastArgs = (
  args: any
): args is { city: string; days?: number } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.city === 'string' &&
  (args.days === undefined || typeof args.days === 'number');

class WeatherServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'example-weather-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: 'http://api.openweathermap.org/data/2.5',
      params: {
        appid: API_KEY,
        units: 'metric',
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // 错误处理
    this.server.onerror = (error) => console.error('[MCP 错误]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // MCP 资源表示 MCP 服务器希望向客户端提供的任何类型的 UTF-8 编码数据，如数据库记录、API 响应、日志文件等。服务器使用静态 URI 定义直接资源，或使用遵循格式 \`[protocol]://[host]/[path]\` 的 URI 模板定义动态资源。
  private setupResourceHandlers() {
    // 对于静态资源，服务器可以暴露资源列表：
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        // 这是一个糟糕的示例，因为您可以使用资源模板获取相同的信息，但这演示了如何定义静态资源
        {
          uri: \`weather://San Francisco/current\`, // 旧金山天气资源的唯一标识符
          name: \`旧金山的当前天气\`, // 人类可读的名称
          mimeType: 'application/json', // 可选的 MIME 类型
          // 可选的描述
          description:
            '旧金山的实时天气数据，包括温度、条件、湿度和风速',
        },
      ],
    }));

    // 对于动态资源，服务器可以暴露资源模板：
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: 'weather://{city}/current', // URI 模板 (RFC 6570)
            name: '给定城市的当前天气', // 人类可读的名称
            mimeType: 'application/json', // 可选的 MIME 类型
            description: '指定城市的实时天气数据', // 可选的描述
          },
        ],
      })
    );

    // ReadResourceRequestSchema 用于静态资源和动态资源模板
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const match = request.params.uri.match(
          /^weather:\/\/([^/]+)\/current$/
        );
        if (!match) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            \`无效的 URI 格式：\${request.params.uri}\`
          );
        }
        const city = decodeURIComponent(match[1]);

        try {
          const response = await this.axiosInstance.get(
            'weather', // 当前天气
            {
              params: { q: city },
            }
          );

          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'application/json',
                text: JSON.stringify(
                  {
                    temperature: response.data.main.temp,
                    conditions: response.data.weather[0].description,
                    humidity: response.data.main.humidity,
                    wind_speed: response.data.wind.speed,
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          if (axios.isAxiosError(error)) {
            throw new McpError(
              ErrorCode.InternalError,
              \`天气 API 错误：\${
                error.response?.data.message ?? error.message
              }\`
            );
          }
          throw error;
        }
      }
    );
  }

  /* MCP 工具使服务器能够向系统暴露可执行功能。通过这些工具，您可以与外部系统交互、执行计算并在现实世界中采取行动。
   * - 与资源一样，工具由唯一名称标识，可以包含描述来指导其使用。但是，与资源不同，工具表示可以修改状态或与外部系统交互的动态操作。
   * - 虽然资源和工具相似，但在可能的情况下，您应该更喜欢创建工具而不是资源，因为它们提供更大的灵活性。
   */
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_forecast', // 唯一标识符
          description: '获取城市的天气预报', // 人类可读的描述
          inputSchema: {
            // 参数的 JSON Schema
            type: 'object',
            properties: {
              city: {
                type: 'string',
                description: '城市名称',
              },
              days: {
                type: 'number',
                description: '天数 (1-5)',
                minimum: 1,
                maximum: 5,
              },
            },
            required: ['city'], // 必需属性名称的数组
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'get_forecast') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          \`未知工具：\${request.params.name}\`
        );
      }

      if (!isValidForecastArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          '无效的预报参数'
        );
      }

      const city = request.params.arguments.city;
      const days = Math.min(request.params.arguments.days || 3, 5);

      try {
        const response = await this.axiosInstance.get<{
          list: OpenWeatherResponse[];
        }>('forecast', {
          params: {
            q: city,
            cnt: days * 8,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response.data.list, null, 2),
            },
          ],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: \`天气 API 错误：\${
                  error.response?.data.message ?? error.message
                }\`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('天气 MCP 服务器在 stdio 上运行');
  }
}

const server = new WeatherServer();
server.run().catch(console.error);
\`\`\`

(记住：这只是一个示例 - 您可以使用不同的依赖项、将实现分解为多个文件等)

3. 构建并编译可执行 JavaScript 文件

\`\`\`bash
npm run build
\`\`\`

4. 每当您需要环境变量（如 API 密钥）来配置 MCP 服务器时，请指导用户获取密钥的过程。例如，他们可能需要创建账户并转到开发者仪表板来生成密钥。提供分步说明和 URL，使用户能够轻松检索必要的信息。然后使用 ask_followup_question 工具询问用户的密钥，在这种情况下是 OpenWeather API 密钥。

5. 通过将 MCP 服务器配置添加到位于 '${await mcpHub.getMcpSettingsFilePath()}' 的设置文件来安装 MCP 服务器。设置文件可能已经配置了其他 MCP 服务器，所以您会先读取它，然后将新服务器添加到现有的 \`mcpServers\` 对象中。

重要：无论您在 MCP 设置文件中看到什么，您必须将创建的任何新 MCP 服务器默认为 disabled=false 和 autoApprove=[]。

\`\`\`json
{
  "mcpServers": {
    ...,
    "weather": {
      "command": "node",
      "args": ["/path/to/weather-server/build/index.js"],
      "env": {
        "OPENWEATHER_API_KEY": "用户提供的-api-key"
      }
    },
  }
}
\`\`\`

(注意：用户也可能要求您将 MCP 服务器安装到 Claude 桌面应用程序，在这种情况下，您会读取然后修改 macOS 上的 \`~/Library/Application\ Support/Claude/claude_desktop_config.json\` 例如。它遵循顶级 \`mcpServers\` 对象的相同格式。)

6. 编辑 MCP 设置配置文件后，系统将自动运行所有服务器并在"已连接的 MCP 服务器"部分中暴露可用的工具和资源。（注意：如果您在测试新安装的 mcp 服务器时遇到"未连接"错误，常见原因是 MCP 设置配置中的构建路径不正确。由于编译的 JavaScript 文件通常输出到 'dist/' 或 'build/' 目录，请仔细检查 MCP 设置中的构建路径是否与文件实际编译的位置匹配。例如，如果您假设 'build' 作为文件夹，请检查 tsconfig.json 以查看它是否使用 'dist' 代替。）

7. 现在您可以访问这些新工具和资源，您可以建议用户命令您调用它们的方式 - 例如，有了这个新的天气工具，您现在可以邀请用户询问"旧金山的天气怎么样？"

## 编辑 MCP 服务器

用户可能要求添加对现有 MCP 服务器有意义的工具或资源（列在下面的"已连接的 MCP 服务器"下：${
		mcpHub
			.getServers()
			.filter((server) => server.status === "connected")
			.map((server) => server.name)
			.join(", ") || "(当前没有运行)"
	}，例如，如果它会使用相同的 API。如果您可以通过查看服务器参数中的文件路径在用户系统上定位 MCP 服务器存储库，这是可能的。然后您可以使用 list_files 和 read_file 探索存储库中的文件，并使用 replace_in_file 对文件进行更改。

但是，一些 MCP 服务器可能从已安装的包而不是本地存储库运行，在这种情况下，创建新的 MCP 服务器可能更有意义。

# MCP 服务器并不总是必需的

用户可能并不总是要求使用或创建 MCP 服务器。相反，他们可能提供可以使用现有工具完成的任务。虽然使用 MCP SDK 扩展您的能力可能有用，但重要的是要理解这只是您可以完成的一种专门类型的任务。您应该只在用户明确要求时实现 MCP 服务器（例如，"添加一个工具来..."）。

记住：上面提供的 MCP 文档和示例是为了帮助您理解和使用现有的 MCP 服务器，或在用户要求时创建新的服务器。您已经可以访问可用于完成各种任务的工具和功能。`
}
