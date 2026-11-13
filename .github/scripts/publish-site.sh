#!/usr/bin/env bash
# Copies web/ to Pip's site bucket and refreshes CloudFront.
# Used by deploy.yml (after the stack deploys) and site.yml (when web/ changes).
# Does nothing until the stack has a SiteDomain.
set -euo pipefail
STACK="${STACK:-pip-hr}"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out SiteBucketName)
DIST=$(out SiteDistributionId)
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "No SiteDomain set on the $STACK stack, so there's no AWS-hosted site to publish. Skipping."
  exit 0
fi
# Pages and scripts are checked for changes on every visit; everything else can be cached.
aws s3 sync web/ "s3://$BUCKET/" --delete --exclude "*" --include "*.html" --include "*.js" --include "*.css" --include "*.json" \
  --cache-control "no-cache" --only-show-errors
aws s3 sync web/ "s3://$BUCKET/" --delete --exclude "*.html" --exclude "*.js" --exclude "*.css" --exclude "*.json" \
  --cache-control "public, max-age=86400" --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text
echo "Published web/ to $(out MemberUrl)"
