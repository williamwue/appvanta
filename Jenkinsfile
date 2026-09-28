pipeline {
  agent { label 'windows' }
  tools { nodejs 'node-22' }
  stages {
    stage('Install') { steps { bat 'npm ci' } }
    stage('Build') { steps { bat 'npm run build' } }
    stage('Test') { steps { bat 'npm test' } }
  }
  post {
    always {
      bat 'node scripts/stage-evidence.mjs .appvanta/runs .appvanta/ci-evidence-%BUILD_NUMBER%'
      archiveArtifacts artifacts: ".appvanta/ci-evidence-${env.BUILD_NUMBER}/**/*", allowEmptyArchive: false
    }
  }
}
