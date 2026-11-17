import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { join } from "node:path";

export interface OracleWebStackProps extends StackProps {
  /** Name of the SSM SecureString parameter holding the Gemini API key. Created outside this stack. */
  geminiKeyParameter: string;
}

/**
 * The hosted runtime: one Lambda function, nothing else.
 *
 * It serves the page, the query API, the agent and the MCP endpoint from a
 * container image of `web/`. There is no database, queue, VPC or always-on
 * compute: the function reads the published snapshot from IPFS when it is
 * invoked and costs nothing while idle.
 */
export class OracleWebStack extends Stack {
  constructor(scope: Construct, id: string, props: OracleWebStackProps) {
    super(scope, id, props);
    Tags.of(this).add("project", "miami-dade-oracle");
    Tags.of(this).add("cost-centre", "oracle-pipeline");

    const logGroup = new logs.LogGroup(this, "WebLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const web = new lambda.DockerImageFunction(this, "Web", {
      description: "Miami-Dade Oracle: page, query API, agent and MCP endpoint over the published IPFS snapshot",
      code: lambda.DockerImageCode.fromImageAsset(join(__dirname, "..", "..", "web")),
      architecture: lambda.Architecture.X86_64,
      // DuckDB scans Parquet in memory; 2 GB keeps a five-mile query well under a second.
      memorySize: 2048,
      // The longest request is an agent question: several model calls and tool runs.
      timeout: Duration.seconds(120),
      // The snapshot tables (about 110 MB) are downloaded into /tmp on a cold start.
      ephemeralStorageSize: Size.mebibytes(1024),
      logGroup,
      environment: {
        GEMINI_KEY_PARAMETER: props.geminiKeyParameter,
      },
    });

    // Least privilege: the function may read exactly one parameter, and nothing else in the account.
    web.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: props.geminiKeyParameter.replace(/^\//, "") })],
      }),
    );

    // Public by design: the assignment requires a runtime anyone can open without credentials.
    // The data is public record and the engine is read-only (see docs/decisions.md, decision 18).
    const url = web.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    new CfnOutput(this, "Url", { value: url.url, description: "Public address of the hosted runtime" });
    new CfnOutput(this, "FunctionName", { value: web.functionName });
  }
}
