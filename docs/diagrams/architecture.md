# System Architecture

High-level architecture of the Oriole AI agent maze navigation platform.

```mermaid
graph TB
    subgraph "External Services"
        Bedrock[AWS Bedrock<br/>Claude/Nova Agents]
        Ollama[Ollama Server<br/>llama3.1, qwen2.5]
    end

    subgraph "AWS Infrastructure"
        EventBridge[EventBridge]
        StepFunctions[Step Functions<br/>State Machine]

        subgraph "Lambda Functions"
            Start[Start Experiment]
            InvokeBedrock[Invoke Bedrock Agent]
            InvokeOllama[Invoke Ollama Agent]
            CheckProgress[Check Progress]
            Finalize[Finalize Experiment]
            ActionRouter[Action Router]

            subgraph "Action Handlers"
                MoveNorth[move_north]
                MoveEast[move_east]
                MoveSouth[move_south]
                MoveWest[move_west]
                RecallAll[recall_all]
            end
        end

        SSM[Parameter Store<br/>- Model configs<br/>- Prompts<br/>- Limits]
        RDS[(PostgreSQL RDS<br/>- experiments<br/>- agent_actions<br/>- mazes)]
    end

    subgraph "Frontend"
        Viewer[Viewer UI<br/>Grid Visualization]
        API[API Gateway]
    end

    EventBridge -->|Trigger| StepFunctions
    StepFunctions --> Start
    Start --> RDS
    Start --> SSM

    StepFunctions -->|Choice: bedrock| InvokeBedrock
    StepFunctions -->|Choice: ollama| InvokeOllama

    InvokeBedrock --> Bedrock
    InvokeOllama --> Ollama
    InvokeOllama --> SSM

    InvokeBedrock --> ActionRouter
    InvokeOllama --> ActionRouter

    ActionRouter --> MoveNorth
    ActionRouter --> MoveEast
    ActionRouter --> MoveSouth
    ActionRouter --> MoveWest
    ActionRouter --> RecallAll

    MoveNorth --> RDS
    MoveEast --> RDS
    MoveSouth --> RDS
    MoveWest --> RDS
    RecallAll --> RDS

    StepFunctions --> CheckProgress
    CheckProgress --> RDS

    StepFunctions --> Finalize
    Finalize --> RDS

    Viewer --> API
    API --> RDS

    style Bedrock fill:#f9f,stroke:#333
    style Ollama fill:#9ff,stroke:#333
    style RDS fill:#ff9,stroke:#333
    style StepFunctions fill:#9f9,stroke:#333
```

## Key Components

### External LLM Providers
- **AWS Bedrock**: Managed AI service (Claude, Nova models)
- **Ollama**: Local LLM server (llama3.1:8b, qwen2.5:7b)

### Orchestration
- **EventBridge**: Triggers experiments on schedule or manual invocation
- **Step Functions**: State machine that orchestrates experiment lifecycle
- **Parameter Store**: Centralized configuration (model params, prompts, limits)

### Compute
- **Lambda Functions**: Serverless execution for each workflow step
- **Action Router**: Directs tool calls to appropriate action handlers

### Storage
- **PostgreSQL RDS**: Persistent storage for experiments, actions, and maze data
- **model_config JSONB**: Stores model configuration for A/B testing

### Frontend
- **Viewer UI**: Web interface for visualizing maze grid and experiment results
- **API Gateway**: REST API for viewer data access
