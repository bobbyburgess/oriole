const { Construct } = require('constructs');
const { Duration } = require('aws-cdk-lib');
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');

class OrioleDashboardConstruct extends Construct {
  constructor(scope, id, props) {
    super(scope, id);

    const {
      invokeAgentLambda,
      checkProgressLambda,
      actionRouterLambda,
      stateMachine
    } = props;

    // Create comprehensive dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'OrioleDashboard', {
      dashboardName: 'Oriole-Grid-Exploration',
      defaultInterval: Duration.hours(6)
    });

    // ============================================
    // ROW 1: Experiment Overview
    // ============================================
    dashboard.addWidgets(
      // Total experiments by status (from Step Functions)
      new cloudwatch.GraphWidget({
        title: 'Step Functions Executions (Last 6h)',
        left: [
          stateMachine.metricSucceeded({ statistic: 'sum', label: 'Succeeded' }),
          stateMachine.metricFailed({ statistic: 'sum', label: 'Failed' }),
          stateMachine.metricTimedOut({ statistic: 'sum', label: 'Timed Out' }),
          stateMachine.metricAborted({ statistic: 'sum', label: 'Aborted' })
        ],
        width: 12,
        stacked: true
      }),

      // Currently running
      new cloudwatch.SingleValueWidget({
        title: 'Running Now',
        metrics: [
          stateMachine.metricStarted({ statistic: 'sum', label: 'Started' }),
          stateMachine.metricSucceeded({ statistic: 'sum', label: 'Completed' })
        ],
        width: 6
      }),

      // Success rate
      new cloudwatch.GraphWidget({
        title: 'Success Rate %',
        left: [
          new cloudwatch.MathExpression({
            expression: '(succeeded / (succeeded + failed + timedout)) * 100',
            usingMetrics: {
              succeeded: stateMachine.metricSucceeded({ statistic: 'sum' }),
              failed: stateMachine.metricFailed({ statistic: 'sum' }),
              timedout: stateMachine.metricTimedOut({ statistic: 'sum' })
            },
            label: 'Success Rate'
          })
        ],
        width: 6,
        leftYAxis: { min: 0, max: 100 }
      })
    );

    // ============================================
    // ROW 2: Lambda Performance (The Bottleneck!)
    // ============================================
    dashboard.addWidgets(
      // Invoke Agent Lambda duration (this is where timeouts happen)
      new cloudwatch.GraphWidget({
        title: 'Invoke Agent Lambda Duration (ms)',
        left: [
          invokeAgentLambda.metricDuration({ statistic: 'avg', label: 'Average' }),
          invokeAgentLambda.metricDuration({ statistic: 'max', label: 'Max' }),
          invokeAgentLambda.metricDuration({ statistic: 'p99', label: 'p99' })
        ],
        width: 12,
        leftAnnotations: [
          { value: 300000, label: '5min timeout (old)', color: cloudwatch.Color.RED },
          { value: 900000, label: '15min timeout (new)', color: cloudwatch.Color.ORANGE }
        ]
      }),

      // Invoke Agent errors and throttles
      new cloudwatch.GraphWidget({
        title: 'Invoke Agent Errors',
        left: [
          invokeAgentLambda.metricErrors({ statistic: 'sum', label: 'Errors' }),
          invokeAgentLambda.metricThrottles({ statistic: 'sum', label: 'Throttles' })
        ],
        width: 6
      }),

      // Check Progress Lambda (should be fast)
      new cloudwatch.GraphWidget({
        title: 'Check Progress Duration (ms)',
        left: [
          checkProgressLambda.metricDuration({ statistic: 'avg', label: 'Average' }),
          checkProgressLambda.metricDuration({ statistic: 'max', label: 'Max' })
        ],
        width: 6
      })
    );

    // ============================================
    // ROW 3: Action Router (Tool Calls)
    // ============================================
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Action Router Invocations (Tool Calls)',
        left: [
          actionRouterLambda.metricInvocations({ statistic: 'sum', label: 'Total Tool Calls' })
        ],
        width: 8
      }),

      new cloudwatch.GraphWidget({
        title: 'Action Router Duration (ms)',
        left: [
          actionRouterLambda.metricDuration({ statistic: 'avg', label: 'Average' }),
          actionRouterLambda.metricDuration({ statistic: 'max', label: 'Max' })
        ],
        width: 8
      }),

      new cloudwatch.GraphWidget({
        title: 'Action Router Errors',
        left: [
          actionRouterLambda.metricErrors({ statistic: 'sum', label: 'Errors' })
        ],
        width: 8
      })
    );

    // ============================================
    // ROW 4: Step Functions Execution Time
    // ============================================
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Step Functions Execution Duration',
        left: [
          stateMachine.metricTime({ statistic: 'avg', label: 'Average' }),
          stateMachine.metricTime({ statistic: 'max', label: 'Max' }),
          stateMachine.metricTime({ statistic: 'p95', label: 'p95' })
        ],
        width: 16
      }),

      new cloudwatch.SingleValueWidget({
        title: 'Longest Execution (ms)',
        metrics: [
          stateMachine.metricTime({ statistic: 'max' })
        ],
        width: 8
      })
    );

    // ============================================
    // ROW 5: Custom Metrics from Logs (Insights)
    // ============================================

    // Create log insights queries for agent behavior
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Bedrock Invocation Timings',
        logGroupNames: [invokeAgentLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /TIMING/',
          'parse @message "[TIMING] * completed in *ms" as action, duration',
          'stats avg(duration) as avg_ms, max(duration) as max_ms, count() as invocations by bin(5m)'
        ],
        width: 12
      }),

      new cloudwatch.LogQueryWidget({
        title: 'Token Usage Over Time',
        logGroupNames: [invokeAgentLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /Token usage/',
          'parse @message "Token usage: * input, * output" as input_tokens, output_tokens',
          'stats sum(input_tokens) as total_input, sum(output_tokens) as total_output by bin(15m)'
        ],
        width: 12
      })
    );

    // ============================================
    // ROW 6: Cost Tracking
    // ============================================
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Cost Per Invocation',
        logGroupNames: [invokeAgentLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /Cost for this invocation/',
          'parse @message "Cost for this invocation: $*" as cost',
          'stats sum(cost) as total_cost, avg(cost) as avg_cost, count() as invocations by bin(15m)'
        ],
        width: 12
      }),

      new cloudwatch.LogQueryWidget({
        title: 'Cumulative Cost',
        logGroupNames: [checkProgressLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /Cumulative tokens/',
          'parse @message "Cumulative tokens: * in, * out, $* total cost" as input_tokens, output_tokens, cost',
          'stats latest(cost) as latest_cost, latest(input_tokens) as latest_input, latest(output_tokens) as latest_output by bin(5m)'
        ],
        width: 12
      })
    );

    // ============================================
    // ROW 7: Error Details
    // ============================================
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Errors (Last 50)',
        logGroupNames: [
          invokeAgentLambda.logGroup.logGroupName,
          actionRouterLambda.logGroup.logGroupName,
          checkProgressLambda.logGroup.logGroupName
        ],
        queryLines: [
          'filter @message like /Error/ or @message like /ERROR/ or level = "error"',
          'fields @timestamp, @message',
          'sort @timestamp desc',
          'limit 50'
        ],
        width: 24
      })
    );

    // ============================================
    // ROW 8: Agent Behavior (from action logs)
    // ============================================
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Agent Actions Breakdown',
        logGroupNames: [actionRouterLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /Router received event/',
          'parse @message /"apiPath":"*"/ as action_type',
          'stats count() as action_count by action_type'
        ],
        width: 12
      }),

      new cloudwatch.LogQueryWidget({
        title: 'Failed Moves (Walls Hit)',
        logGroupNames: [actionRouterLambda.logGroup.logGroupName],
        queryLines: [
          'filter @message like /blocked by wall/ or @message like /Hit wall/',
          'stats count() as wall_hits by bin(15m)'
        ],
        width: 12
      })
    );

    this.dashboard = dashboard;
  }
}

module.exports = { OrioleDashboardConstruct };
