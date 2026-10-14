Feature: Get the first failure back while the other checks keep running

  An agent runs its checks through firstlight so it can start fixing the
  first failure while the slower checks are still going. It reads the rest
  later, and then runs only what did not pass.

  Scenario: a fast failure returns before a slow check finishes, and only the failure runs again
    Given a git repository with a fast failing check and a slow passing check
    When the agent runs both checks with firstlight
    Then firstlight returns with the fast check's failure while the slow check is still running
    And the next command it names is to wait for the results
    When the agent waits for the results
    Then the slow check has passed
    When the agent runs only the checks that did not pass
    Then only the fast check runs again
