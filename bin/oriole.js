#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { OrioleStack } = require('../lib/oriole-stack');

const app = new cdk.App();

new OrioleStack(app, 'OrioleStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2'
  }
});

app.synth();
